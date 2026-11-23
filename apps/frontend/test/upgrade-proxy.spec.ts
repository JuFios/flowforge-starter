import { expect, test } from '@playwright/test';
import { createServer as createHttpServer } from 'node:http';
import { connect, type Socket } from 'node:net';
import { InstancePool, readyProbe } from '../lib/instance-pool';
import { createUpgradeProxy } from '../lib/upgrade-proxy';
import {
  closedPort,
  listen,
  resettingApi,
  silentApi,
  slowRouteApi,
  track,
} from './fake-api';

/**
 * Проксі `/realtime` без браузера: вбудовані інстанси API і сирий клієнт. Тикет одноразовий, тож
 * повтор на інший інстанс безпечний, лише поки запит із тикетом не міг дійти до першого.
 */
const ORIGIN = 'http://front.test';
const TICKET = 'ticket_0123456789';

/** Інстанс, що приймає upgrade і записує, який тикет отримав. */
async function upgradingApi() {
  const tickets: string[] = [];
  const server = createHttpServer();
  server.on('upgrade', (req, socket: Socket) => {
    track(socket);
    tickets.push(
      new URL(req.url ?? '', 'http://x').searchParams.get('ticket') ?? '',
    );
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    );
  });
  return { url: await listen(server), tickets };
}

/** Проксі з пулом, чиї перевірки `/ready` тест може дочекатися. */
async function proxyTo(
  apiUrls: URL[],
  pool = new InstancePool(apiUrls.length, readyProbe(apiUrls, 200)),
): Promise<URL> {
  const proxy = createUpgradeProxy({
    apiUrls,
    publicOrigin: ORIGIN,
    connectTimeoutMs: 1_000,
    responseTimeoutMs: 300,
    pool,
  });
  const server = createHttpServer();
  server.on('upgrade', (req, socket: Socket, head: Buffer) => {
    track(socket);
    socket.on('error', () => socket.destroy());
    req.headers['x-forwarded-for'] = '127.0.0.1';
    proxy(req, socket, head);
  });
  return listen(server);
}

/** Сирий upgrade через проксі; повертає сокет і рядок статусу відповіді. */
async function upgrade(
  proxy: URL,
): Promise<{ socket: Socket; status: Promise<string> }> {
  const socket = connect(Number(proxy.port), proxy.hostname);
  track(socket);
  socket.on('error', () => undefined);
  await new Promise<void>((r) => socket.once('connect', () => r()));
  const status = new Promise<string>((resolve) => {
    let data = '';
    socket.on('data', (chunk: Buffer) => {
      data += chunk.toString('latin1');
      if (data.includes('\r\n')) resolve(data.split('\r\n')[0]);
    });
    socket.once('close', () => resolve(data.split('\r\n')[0] ?? ''));
  });
  socket.write(
    `GET /realtime?ticket=${TICKET} HTTP/1.1\r\nHost: front.test\r\nOrigin: ${ORIGIN}\r\n` +
      'Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n' +
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
  );
  return { socket, status };
}

test('does not resend a ticket to another instance after the first one received it', async () => {
  const slow = await silentApi();
  const other = await upgradingApi();
  const { status } = await upgrade(await proxyTo([slow.url, other.url]));
  expect(await status).toBe('HTTP/1.1 504 Gateway Timeout');
  expect(slow.requests.join('')).toContain(`ticket=${TICKET}`);
  expect(other.tickets).toEqual([]);
});

test('starts the next upgrade at another instance after one hung on a ticket', async () => {
  const slow = await silentApi();
  const other = await upgradingApi();
  const pool = new InstancePool(2, readyProbe([slow.url, other.url], 200));
  const proxy = await proxyTo([slow.url, other.url], pool);
  expect(await (await upgrade(proxy)).status).toBe(
    'HTTP/1.1 504 Gateway Timeout',
  );
  await pool.settled();
  expect(await (await upgrade(proxy)).status).toBe(
    'HTTP/1.1 101 Switching Protocols',
  );
  // Upgrade із тикетом і перевірка `/ready`, яку завислий інстанс не пройшов.
  expect(slow.paths()).toEqual([`/realtime?ticket=${TICKET}`, '/ready']);
  expect(other.tickets).toEqual([TICKET]);
});

test('keeps a live instance first after a ticket it answered too slowly', async () => {
  const live = await slowRouteApi();
  const other = await upgradingApi();
  const pool = new InstancePool(2, readyProbe([live.url, other.url], 200));
  const proxy = await proxyTo([live.url, other.url], pool);
  for (let round = 0; round < 2; round++) {
    expect(await (await upgrade(proxy)).status).toBe(
      'HTTP/1.1 504 Gateway Timeout',
    );
    await pool.settled();
  }
  // Живий інстанс (`/ready` відповідає) лишається першим: повільний запит його не позначає.
  expect(live.paths).toEqual([
    `/realtime?ticket=${TICKET}`,
    '/ready',
    `/realtime?ticket=${TICKET}`,
    '/ready',
  ]);
  expect(other.tickets).toEqual([]);
});

test('does not resend a ticket after the connection breaks mid-request', async () => {
  const broken = await resettingApi();
  const other = await upgradingApi();
  const { status } = await upgrade(await proxyTo([broken.url, other.url]));
  expect(await status).toBe('HTTP/1.1 502 Bad Gateway');
  expect(broken.requests.join('')).toContain(`ticket=${TICKET}`);
  expect(other.tickets).toEqual([]);
});

test('fails over to the next instance when the first refuses the connection', async () => {
  const other = await upgradingApi();
  const { status } = await upgrade(
    await proxyTo([await closedPort(), other.url]),
  );
  expect(await status).toBe('HTTP/1.1 101 Switching Protocols');
  expect(other.tickets).toEqual([TICKET]);
});

test('closes the upstream request when the browser leaves before a response', async () => {
  test.setTimeout(10_000);
  const slow = await silentApi();
  const { socket } = await upgrade(await proxyTo([slow.url]));
  await expect.poll(() => slow.requests.length).toBeGreaterThan(0);
  socket.destroy();
  await Promise.all(slow.closed);
});
