import {
  createServer,
  IncomingMessage,
  request as httpRequest,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';
import next from 'next';
import { clientIp, parseTrustProxy, peerIsTrustedProxy } from './lib/client-ip';

/**
 * Власний HTTP-сервер фронтенду (README, «Межа довіри браузера»). Він потрібен з двох причин:
 *
 * 1. Справжня адреса клієнта. Next 14 зберігає `X-Forwarded-For`, надісланий браузером, а адресу
 *    сокета до route handler-ів не передає. Тут адреса обчислюється з сокета й довірених проксі
 *    (FRONTEND_TRUST_PROXY), а вхідні `x-forwarded-*` перезаписуються до того, як запит побачить Next.
 * 2. WebSocket. Route handler-и App Router не приймають upgrade, тож `/realtime` проксіюється
 *    тут до API з того самого origin: cookie, CSP і TLS — одні для сторінки й сокета.
 */
const dev = process.argv.includes('--dev');
const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOSTNAME ?? '0.0.0.0';
const trust = parseTrustProxy(process.env.FRONTEND_TRUST_PROXY);
const apiUrls = (
  process.env.API_URLS ??
  process.env.API_URL ??
  'http://localhost:3000'
)
  .split(',')
  .map((part) => new URL(part.trim()));
const publicOrigin = process.env.PUBLIC_ORIGIN?.trim() || undefined;
/** Скільки чекати з'єднання з API для WebSocket, перш ніж спробувати наступний інстанс. */
const WS_CONNECT_TIMEOUT_MS = 5_000;
/** Найдовший шлях upgrade: `/realtime?ticket=` + токен. */
const MAX_UPGRADE_URL = 256;

function forwardedProto(req: IncomingMessage): 'http' | 'https' {
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
function normalizeForwarded(req: IncomingMessage): void {
  const ip = clientIp(
    req.socket.remoteAddress,
    req.headers['x-forwarded-for'],
    trust,
  );
  const proto = forwardedProto(req);
  for (const name of Object.keys(req.headers))
    if (name.startsWith('x-forwarded-') || name === 'forwarded')
      delete req.headers[name];
  req.headers['x-forwarded-for'] = ip;
  req.headers['x-forwarded-proto'] = proto;
}

function expectedOrigin(req: IncomingMessage): string | undefined {
  if (publicOrigin) return publicOrigin;
  const host = req.headers.host;
  return host
    ? `${req.headers['x-forwarded-proto'] as string}://${host}`
    : undefined;
}

function reject(socket: Duplex, status: number, reason: string): void {
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

/**
 * Upgrade `/realtime` → API. Перевіряється лише Origin (чужа сторінка не відкриє сокет від імені
 * браузера) і форма шляху; тикет погашає API. Інстанс API, що не відповідає, пропускається.
 */
function proxyUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  attempt = 0,
  first = preferred,
): void {
  const url = req.url ?? '';
  if (
    url.length > MAX_UPGRADE_URL ||
    !/^\/realtime\?ticket=[A-Za-z0-9_-]{1,128}$/.test(url)
  )
    return reject(socket, 404, 'Not Found');
  if (req.headers.origin !== expectedOrigin(req))
    return reject(socket, 403, 'Forbidden');
  if (attempt >= apiUrls.length) return reject(socket, 502, 'Bad Gateway');
  const target = apiUrls[(attempt + first) % apiUrls.length];
  const headers: Record<string, string> = {
    connection: 'Upgrade',
    upgrade: 'websocket',
    'x-forwarded-for': req.headers['x-forwarded-for'] as string,
  };
  for (const name of [
    'sec-websocket-key',
    'sec-websocket-version',
    'sec-websocket-extensions',
    'origin',
  ])
    if (typeof req.headers[name] === 'string')
      headers[name] = req.headers[name] as string;
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const upstream = send({
    host: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: url,
    method: 'GET',
    headers,
    timeout: WS_CONNECT_TIMEOUT_MS,
  });
  let connected = false;
  const fail = () => {
    upstream.destroy();
    const retry = !connected && !socket.destroyed;
    connected = true;
    if (retry) proxyUpgrade(req, socket, head, attempt + 1, first);
  };
  upstream.on('timeout', fail);
  upstream.on('error', fail);
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
  upstream.on('response', (res) => {
    // API відмовив до upgrade (тикет недійсний, ліміт): статус і Retry-After — браузеру.
    connected = true;
    const retryAfter = res.headers['retry-after'];
    socket.end(
      `HTTP/1.1 ${res.statusCode ?? 502} ${res.statusMessage ?? ''}\r\n` +
        (typeof retryAfter === 'string'
          ? `Retry-After: ${retryAfter}\r\n`
          : '') +
        'Connection: close\r\nContent-Length: 0\r\n\r\n',
    );
    res.resume();
  });
  upstream.on('upgrade', (res, upstreamSocket, upstreamHead) => {
    connected = true;
    upstreamSocket.setTimeout(0);
    preferred = (attempt + first) % apiUrls.length;
    const lines = [`HTTP/1.1 101 Switching Protocols`];
    for (const [name, value] of Object.entries(res.headers))
      if (typeof value === 'string') lines.push(`${name}: ${value}`);
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) upstreamSocket.write(head);
    // pipe тримає backpressure в обидва боки; закриття одного боку закриває інший.
    upstreamSocket.pipe(socket).pipe(upstreamSocket);
    const close = () => {
      upstreamSocket.destroy();
      socket.destroy();
    };
    upstreamSocket.on('error', close);
    upstreamSocket.on('close', close);
    socket.on('error', close);
    socket.on('close', close);
  });
  upstream.end();
}

let preferred = 0;

async function main(): Promise<void> {
  // Next реєструє власний upgrade при першому HTTP-запиті. Окремий об’єкт
  // сервера приймає лише HMR; сокетом /realtime володіє один обробник.
  const nextServer = createServer();
  const app = next({ dev, hostname, port, httpServer: nextServer });
  const handle = app.getRequestHandler();
  await app.prepare();

  const server = createServer((req, res) => {
    normalizeForwarded(req);
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/_next/image') {
      res.writeHead(404).end();
      return;
    }
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy();
    });
  });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    normalizeForwarded(req);
    if ((req.url ?? '').startsWith('/realtime'))
      return proxyUpgrade(req, socket, head);
    // У режимі розробки — HMR Next; у production інших upgrade немає.
    if (dev && nextServer.emit('upgrade', req, socket, head)) return;
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
    server.close();
    server.closeAllConnections();
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
