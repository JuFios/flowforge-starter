import { IncomingMessage, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { InstancePool, readyProbe } from './instance-pool';

/** Найдовший шлях upgrade: `/realtime?ticket=` + токен. */
const MAX_UPGRADE_URL = 256;

export interface UpgradeProxyOptions {
  apiUrls: URL[];
  publicOrigin?: string;
  /** Скільки чекати з'єднання з інстансом API, перш ніж спробувати наступний. */
  connectTimeoutMs: number;
  /** Скільки чекати відповіді API після надсилання запиту з тикетом. */
  responseTimeoutMs: number;
  /** Порядок перебору інстансів (у тестах — з керованим годинником). */
  pool?: InstancePool;
}

export function expectedOrigin(
  req: IncomingMessage,
  publicOrigin?: string,
): string | undefined {
  if (publicOrigin) return publicOrigin;
  const host = req.headers.host;
  return host
    ? `${req.headers['x-forwarded-proto'] as string}://${host}`
    : undefined;
}

export function reject(socket: Duplex, status: number, reason: string): void {
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

/**
 * Upgrade `/realtime` → API. Перевіряється лише Origin (чужа сторінка не відкриє сокет від імені
 * браузера) і форма шляху; тикет погашає API. Інстанс, з яким не вдалося з'єднатися, пропускається;
 * після встановлення з'єднання таймаут чи обрив повертають браузеру 504/502 без повтору.
 */
export function createUpgradeProxy(
  options: UpgradeProxyOptions,
): (req: IncomingMessage, socket: Duplex, head: Buffer) => void {
  const { apiUrls, publicOrigin, connectTimeoutMs, responseTimeoutMs } =
    options;
  /** Той самий запобіжник, що й для HTTP (`lib/instance-pool.ts`): завислий API не стоїть першим. */
  const pool =
    options.pool ?? new InstancePool(apiUrls.length, readyProbe(apiUrls));

  function proxyUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    order: number[],
    position: number,
  ): void {
    if (position >= order.length) return reject(socket, 502, 'Bad Gateway');
    const url = req.url ?? '';
    const index = order[position];
    const attempt = pool.begin();
    const target = apiUrls[index];
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
    const tls = target.protocol === 'https:';
    // Окреме з'єднання на кожен upgrade (без пулу agent-а): сокет із пулу міг бути вже закритий
    // API, і тоді обрив після надсилання не відрізнити від відмови з'єднання.
    const upstream = (tls ? httpsRequest : httpRequest)(new URL(url, target), {
      method: 'GET',
      headers,
      agent: false,
    });
    /** З'єднання встановлено: запит із тикетом міг дійти до API, і той міг його погасити. */
    let sent = false;
    /** Відповідь API (відмова чи upgrade) вже передається браузеру. */
    let settled = false;
    const cleanup = () => {
      clearTimeout(deadline);
      socket.off('error', abort);
      socket.off('close', abort);
    };
    const abort = () => {
      settled = true;
      cleanup();
      upstream.destroy();
    };
    const fail = (reason: 'timeout' | 'error') => {
      const open = !settled && !socket.destroyed;
      abort();
      if (!open) return;
      // Лише поки з'єднання не встановлено, тикет точно не дійшов до API (як у lib/upstream.ts):
      // інстанс позначається одразу, а upgrade іде на наступний.
      if (!sent) {
        pool.failed(index, attempt);
        return proxyUpgrade(req, socket, head, order, position + 1);
      }
      // Інакше інший інстанс отримав би вже погашений тикет: браузер візьме новий. Чи обходити
      // інстанс наступним upgrade-ам, вирішує перевірка `/ready`, а не цей запит.
      pool.check(index, attempt);
      if (reason === 'timeout') reject(socket, 504, 'Gateway Timeout');
      else reject(socket, 502, 'Bad Gateway');
    };
    let deadline = setTimeout(() => fail('timeout'), connectTimeoutMs).unref();
    upstream.once('socket', (raw: Socket) => {
      const opened = () => {
        if (settled) return;
        sent = true;
        clearTimeout(deadline);
        deadline = setTimeout(() => fail('timeout'), responseTimeoutMs).unref();
      };
      if (!raw.connecting) opened();
      else raw.once(tls ? 'secureConnect' : 'connect', opened);
    });
    upstream.on('error', () => fail('error'));
    socket.once('error', abort);
    socket.once('close', abort);
    upstream.on('response', (res) => {
      // API відмовив до upgrade (тикет недійсний, ліміт): статус і Retry-After — браузеру.
      settled = true;
      pool.succeeded(index, attempt);
      const retryAfter = res.headers['retry-after'];
      socket.end(
        `HTTP/1.1 ${res.statusCode ?? 502} ${res.statusMessage ?? ''}\r\n` +
          (typeof retryAfter === 'string'
            ? `Retry-After: ${retryAfter}\r\n`
            : '') +
          'Connection: close\r\nContent-Length: 0\r\n\r\n',
      );
      res.resume();
      res.once('end', cleanup);
      res.once('close', cleanup);
    });
    upstream.on('upgrade', (res, upstreamSocket, upstreamHead) => {
      settled = true;
      cleanup();
      if (socket.destroyed) {
        upstreamSocket.destroy();
        return;
      }
      upstreamSocket.setTimeout(0);
      pool.succeeded(index, attempt);
      const lines = [`HTTP/1.1 101 Switching Protocols`];
      for (const name of [
        'upgrade',
        'connection',
        'sec-websocket-accept',
        'sec-websocket-extensions',
        'sec-websocket-protocol',
      ]) {
        const value = res.headers[name];
        if (typeof value === 'string') lines.push(`${name}: ${value}`);
      }
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

  return (req, socket, head) => {
    const url = req.url ?? '';
    if (
      url.length > MAX_UPGRADE_URL ||
      !/^\/realtime\?ticket=[A-Za-z0-9_-]{1,128}$/.test(url)
    )
      return reject(socket, 404, 'Not Found');
    const origin = expectedOrigin(req, publicOrigin);
    if (!origin || req.headers.origin !== origin)
      return reject(socket, 403, 'Forbidden');
    proxyUpgrade(req, socket, head, pool.order(), 0);
  };
}
