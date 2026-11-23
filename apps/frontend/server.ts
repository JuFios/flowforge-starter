import { createServer, IncomingMessage } from 'node:http';
import { posix } from 'node:path';
import type { Duplex } from 'node:stream';
import { parseArgs } from 'node:util';
import { loadEnvConfig } from '@next/env';
import next from 'next';
import { clientIp, parseTrustProxy, peerIsTrustedProxy } from './lib/client-ip';
import { frontendConfig } from './lib/server-config';
import {
  createUpgradeProxy,
  expectedOrigin,
  reject,
} from './lib/upgrade-proxy';

/**
 * Власний HTTP-сервер фронтенду (README, «Межа довіри браузера»). Він потрібен з двох причин:
 *
 * 1. Справжня адреса клієнта. Next 14 зберігає `X-Forwarded-For`, надісланий браузером, а адресу
 *    сокета до route handler-ів не передає. Тут адреса обчислюється з сокета й довірених проксі
 *    (FRONTEND_TRUST_PROXY), а вхідні `x-forwarded-*` перезаписуються до того, як запит побачить Next.
 * 2. WebSocket. Route handler-и App Router не приймають upgrade, тож `/realtime` проксіюється
 *    тут до API з того самого origin: cookie, CSP і TLS — одні для сторінки й сокета.
 */
/** Скільки чекати з'єднання з API для WebSocket, перш ніж спробувати наступний інстанс. */
const WS_CONNECT_TIMEOUT_MS = 5_000;
/**
 * Скільки чекати відповіді API на upgrade після надсилання тикета. Довше за 8 с, які API дає
 * на перевірку тикета, тож браузер отримує власну відповідь API, а не таймаут проксі.
 */
const WS_RESPONSE_TIMEOUT_MS = 10_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

type TrustProxy = ReturnType<typeof parseTrustProxy>;

function forwardedProto(
  req: IncomingMessage,
  trust: TrustProxy,
): 'http' | 'https' {
  if ((req.socket as { encrypted?: boolean }).encrypted) return 'https';
  // Схему від проксі приймаємо, лише якщо безпосередньому співрозмовнику довіряємо як проксі.
  if (!peerIsTrustedProxy(req.socket.remoteAddress, trust)) return 'http';
  const raw = req.headers['x-forwarded-proto'];
  const last = (Array.isArray(raw) ? raw.join(',') : (raw ?? ''))
    .split(',')
    .pop()
    ?.trim();
  return last === 'https' ? 'https' : 'http';
}

/** Перезаписує заголовки походження запиту значеннями, яким можна довіряти. */
function normalizeForwarded(req: IncomingMessage, trust: TrustProxy): void {
  const ip = clientIp(
    req.socket.remoteAddress,
    req.headers['x-forwarded-for'],
    trust,
  );
  const proto = forwardedProto(req, trust);
  for (const name of Object.keys(req.headers))
    if (name.startsWith('x-forwarded-') || name === 'forwarded')
      delete req.headers[name];
  req.headers['x-forwarded-for'] = ip;
  req.headers['x-forwarded-proto'] = proto;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      dev: { type: 'boolean' },
      port: { type: 'string', short: 'p' },
    },
  });
  const dev = values.dev ?? false;
  loadEnvConfig(process.cwd(), dev);
  const rawPort = values.port ?? process.env.PORT ?? '3000';
  const port = Number(rawPort);
  if (!/^\d{1,5}$/.test(rawPort) || port < 1 || port > 65_535)
    throw new Error('PORT must be an integer from 1 to 65535');
  const hostname = process.env.HOSTNAME ?? '0.0.0.0';
  const config = frontendConfig();
  const proxyUpgrade = createUpgradeProxy({
    apiUrls: config.apiUrls,
    publicOrigin: config.publicOrigin,
    connectTimeoutMs: WS_CONNECT_TIMEOUT_MS,
    responseTimeoutMs: WS_RESPONSE_TIMEOUT_MS,
  });
  const trust = parseTrustProxy(process.env.FRONTEND_TRUST_PROXY);
  // Next реєструє власний upgrade при першому HTTP-запиті. Окремий об’єкт
  // сервера приймає лише HMR; сокетом /realtime володіє один обробник.
  const nextServer = createServer();
  const app = next({ dev, hostname, port, httpServer: nextServer });
  const handle = app.getRequestHandler();
  await app.prepare();

  const upgraded = new Set<Duplex>();
  let stopping = false;
  const server = createServer((req, res) => {
    normalizeForwarded(req, trust);
    for (const name of Object.keys(req.headers)) {
      if (
        name.startsWith('x-middleware-') ||
        name.startsWith('x-invoke-') ||
        name === 'x-matched-path' ||
        name === 'x-now-route-matches' ||
        name === 'content-security-policy' ||
        name === 'content-security-policy-report-only' ||
        name === 'x-nonce' ||
        name === 'next-action'
      )
        delete req.headers[name];
    }
    let path: string;
    try {
      const rawPath = (req.url ?? '/').split('?')[0];
      path = posix.normalize(
        '/' + decodeURIComponent(rawPath).replace(/\\/g, '/'),
      );
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (path.replace(/\/$/, '') === '/_next/image') {
      res.writeHead(404).end();
      return;
    }
    if (!path.startsWith('/_next/static/'))
      res.setHeader('Cache-Control', 'private, no-store');
    if (
      req.method !== 'GET' &&
      req.method !== 'HEAD' &&
      !path.startsWith('/api/')
    ) {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy();
    });
  });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (stopping) {
      socket.destroy();
      return;
    }
    upgraded.add(socket);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => upgraded.delete(socket));
    normalizeForwarded(req, trust);
    if ((req.url ?? '').startsWith('/realtime'))
      return proxyUpgrade(req, socket, head);
    // У режимі розробки — HMR Next; у production інших upgrade немає.
    if (
      dev &&
      (req.url ?? '').split('?')[0] === '/_next/webpack-hmr' &&
      req.headers.origin === expectedOrigin(req, config.publicOrigin) &&
      nextServer.emit('upgrade', req, socket, head)
    )
      return;
    reject(socket, 404, 'Not Found');
  });
  // Повільний клієнт не тримає з'єднання безкінечно (slowloris).
  server.headersTimeout = 20_000;
  server.requestTimeout = 60_000;
  server.listen(port, hostname, () => {
    process.stdout.write(
      JSON.stringify({ level: 'info', msg: 'frontend listening', port, dev }) +
        '\n',
    );
  });
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => {
      server.closeAllConnections();
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
    const drained = new Promise<void>((resolve) =>
      server.close(() => resolve()),
    );
    for (const socket of upgraded) socket.destroy();
    void drained
      .then(() => app.close())
      .then(
        () => {
          clearTimeout(deadline);
          // Next 14 лишає фонові дескриптори навіть після close(), зокрема watcher у dev.
          process.exit(0);
        },
        (err: unknown) => {
          process.stderr.write(`frontend shutdown failed: ${String(err)}\n`);
          process.exit(1);
        },
      );
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

main().catch((err: unknown) => {
  process.stderr.write(
    JSON.stringify({
      level: 'error',
      msg: 'frontend failed to start',
      error: String(err),
    }) + '\n',
  );
  process.exit(1);
});
