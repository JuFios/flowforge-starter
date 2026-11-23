import { expect, test } from '@playwright/test';
import { createServer as createHttpServer, type Server } from 'node:http';
import {
  connect,
  createServer as createTcpServer,
  type AddressInfo,
  type Socket,
} from 'node:net';
import { createUpgradeProxy } from '../lib/upgrade-proxy';

/**
 * Проксі `/realtime` без браузера: вбудовані інстанси API і сирий клієнт. Тикет одноразовий, тож
 * повтор на інший інстанс безпечний, лише поки запит із тикетом не міг дійти до першого.
 */
const ORIGIN = 'http://front.test';
const TICKET = 'ticket_0123456789';

type Closable = { close(cb?: () => void): unknown };
const opened: Closable[] = [];
const sockets: Socket[] = [];

test.afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(
    opened.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
});

function listen<T extends Server | ReturnType<typeof createTcpServer>>(
  server: T,
): Promise<URL> {
  opened.push(server);
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve(
        new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
      ),
    ),
  );
}

/** Інстанс, що приймає з'єднання, читає запит і нічого не відповідає. */
async function silentApi() {
  const requests: string[] = [];
  const closed: Promise<void>[] = [];
  const server = createTcpServer((socket) => {
    sockets.push(socket);
    closed.push(new Promise((r) => socket.once('close', () => r())));
    socket.on('data', (chunk) => requests.push(chunk.toString('latin1')));
    socket.on('error', () => undefined);
  });
  return { url: await listen(server), requests, closed };
}

/** Інстанс, що обриває з'єднання, щойно отримав запит. */
async function resettingApi() {
  const requests: string[] = [];
  const server = createTcpServer((socket) => {
    socket.on('error', () => undefined);
    socket.once('data', (chunk) => {
      requests.push(chunk.toString('latin1'));
      socket.destroy();
    });
  });
  return { url: await listen(server), requests };
}

/** Інстанс, що приймає upgrade і записує, який тикет отримав. */
async function upgradingApi() {
  const tickets: string[] = [];
  const server = createHttpServer();
  server.on('upgrade', (req, socket: Socket) => {
    sockets.push(socket);
    tickets.push(
      new URL(req.url ?? '', 'http://x').searchParams.get('ticket') ?? '',
    );
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    );
  });
  return { url: await listen(server), tickets };
}

/** Адреса, на якій ніхто не слухає (з'єднання відхиляється). */
async function closedPort(): Promise<URL> {
  const server = createTcpServer();
  const url = await new Promise<URL>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve(
        new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
      ),
    ),
  );
  await new Promise<void>((r) => server.close(() => r()));
  return url;
}

async function proxyTo(apiUrls: URL[]): Promise<URL> {
  const proxy = createUpgradeProxy({
    apiUrls,
    publicOrigin: ORIGIN,
    connectTimeoutMs: 1_000,
    responseTimeoutMs: 300,
  });
  const server = createHttpServer();
  server.on('upgrade', (req, socket: Socket, head: Buffer) => {
    sockets.push(socket);
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
  sockets.push(socket);
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
