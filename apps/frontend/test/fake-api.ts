import { test } from '@playwright/test';
import { createServer as createHttpServer, type Server } from 'node:http';
import {
  createServer as createTcpServer,
  type AddressInfo,
  type Socket,
} from 'node:net';

/**
 * Вбудовані інстанси API для тестів проксі без браузера (HTTP — `lib/upstream.ts`, WebSocket —
 * `lib/upgrade-proxy.ts`): мовчазний, що обриває з'єднання, і адреса без слухача. Усе відкрите
 * закривається після кожного тесту.
 */
type Closable = { close(cb?: () => void): unknown };
const opened: Closable[] = [];
const sockets: Socket[] = [];

test.afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(
    opened.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
});

/** Сокет, який треба знищити після тесту (інакше `close` сервера чекав би на нього). */
export function track(socket: Socket): void {
  sockets.push(socket);
}

export function listen<T extends Server | ReturnType<typeof createTcpServer>>(
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

/** Інстанс, що приймає з'єднання, читає запит і нічого не відповідає (завислий API). */
export async function silentApi() {
  const requests: string[] = [];
  const closed: Promise<void>[] = [];
  const server = createTcpServer((socket) => {
    track(socket);
    closed.push(new Promise((r) => socket.once('close', () => r())));
    socket.on('data', (chunk) => requests.push(chunk.toString('latin1')));
    socket.on('error', () => undefined);
  });
  return {
    url: await listen(server),
    requests,
    closed,
    /** Шляхи отриманих запитів (рядок запиту в першому фрагменті кожного). */
    paths: () =>
      requests.flatMap(
        (chunk) => /^[A-Z]+ (\S+) HTTP\/1\.1\r\n/.exec(chunk)?.[1] ?? [],
      ),
  };
}

/** Інстанс, що обриває з'єднання, щойно отримав запит. */
export async function resettingApi() {
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

/** Справний HTTP-інстанс: відповідає 200 і записує шляхи отриманих запитів. */
export async function healthyApi() {
  const paths: string[] = [];
  const server = createHttpServer((req, res) => {
    paths.push(req.url ?? '');
    req.resume();
    req.once('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  server.keepAliveTimeout = 1;
  return { url: await listen(server), paths };
}

/** Адреса, на якій ніхто не слухає (з'єднання відхиляється). */
export async function closedPort(): Promise<URL> {
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
