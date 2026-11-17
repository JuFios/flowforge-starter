import { createServer, Server, Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { DataSource } from 'typeorm';
import type { RunningApp } from '../helpers/app';

const PENDING = Symbol('still pending');

/** Результат промісу або PENDING, якщо він не завершився за `ms` (тест не повинен зависати сам). */
async function within<T>(ms: number, promise: Promise<T>): Promise<T | typeof PENDING> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<typeof PENDING>((resolve) => (timer = setTimeout(() => resolve(PENDING), ms)));
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function settle(promise: Promise<unknown>): Promise<{ error?: unknown }> {
  try {
    await promise;
    return {};
  } catch (error) {
    return { error };
  }
}

describe('database calls are bounded by timeouts', () => {
  describe('statement timeout (application connection)', () => {
    let running: RunningApp;

    beforeAll(async () => {
      // Оточення читається під час імпорту модуля застосунку, тож імпорт — після налаштування.
      process.env.DB_STATEMENT_TIMEOUT_MS = '300';
      const { startApp } = await import('../helpers/app');
      running = await startApp();
    });

    afterAll(() => running?.close());

    it('cancels a query that runs longer than DB_STATEMENT_TIMEOUT_MS', async () => {
      const started = Date.now();
      const outcome = await within(5_000, settle(running.app.get(DataSource).query('SELECT pg_sleep(3)')));

      expect(outcome).not.toBe(PENDING);
      const { error } = outcome as { error?: unknown };
      // 57014 query_canceled: «canceling statement due to statement timeout».
      expect(error).toMatchObject({ driverError: { code: '57014' } });
      expect(Date.now() - started).toBeLessThan(2_000);
    });
  });

  describe('connect timeout (migration CLI connection)', () => {
    let silent: Server;
    const sockets: Socket[] = [];

    beforeAll(async () => {
      // Приймає TCP-з'єднання й нічого не відповідає — як завислий сервер або мережевий шлюз.
      silent = createServer((socket) => sockets.push(socket));
      await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    });

    afterAll(async () => {
      sockets.forEach((s) => s.destroy());
      await new Promise((resolve) => silent.close(resolve));
    });

    it('gives up connecting to a server that never answers after DB_CONNECT_TIMEOUT_MS', async () => {
      const { port } = silent.address() as AddressInfo;
      process.env.DATABASE_URL = `postgres://flowforge:flowforge@127.0.0.1:${port}/flowforge_test`;
      process.env.DB_CONNECT_TIMEOUT_MS = '300';
      const { default: cliDataSource } = await import('../../src/database/data-source');

      const started = Date.now();
      const outcome = await within(5_000, settle(cliDataSource.initialize()));

      expect(outcome).not.toBe(PENDING);
      expect((outcome as { error?: unknown }).error).toBeInstanceOf(Error);
      expect(Date.now() - started).toBeLessThan(2_000);
    });
  });
});
