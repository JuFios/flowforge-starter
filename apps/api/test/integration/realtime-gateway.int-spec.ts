import WebSocket = require('ws');
import { DataSource } from 'typeorm';
import type { RunningApp } from '../helpers/app';
import {
  createExecution,
  createTenant,
  createWorkflow,
  openTestDataSource,
  truncateAll,
} from '../helpers/db';

/**
 * Рукостискання й життєвий цикл сокета `/realtime` (README, «Протокол WebSocket»): недійсний або
 * прострочений тикет відхиляється до upgrade, ліміт з'єднань тенанта діє й для паралельних
 * рукостискань, відкликання сесії закриває вже відкритий сокет, клієнт нічого не надсилає.
 */
describe('realtime gateway handshake and lifecycle', () => {
  const PER_TENANT = 2;
  let ds: DataSource;
  let app: RunningApp;
  const sockets: WebSocket[] = [];

  beforeAll(async () => {
    ds = await openTestDataSource();
    // Конфігурація читається під час імпорту модуля застосунку: ліміт — в ізольованому реєстрі.
    const saved = process.env.REALTIME_MAX_CONNECTIONS_PER_TENANT;
    process.env.REALTIME_MAX_CONNECTIONS_PER_TENANT = String(PER_TENANT);
    try {
      await jest.isolateModulesAsync(async () => {
        const { startApp } = await import('../helpers/app');
        app = await startApp();
      });
    } finally {
      if (saved === undefined)
        delete process.env.REALTIME_MAX_CONNECTIONS_PER_TENANT;
      else process.env.REALTIME_MAX_CONNECTIONS_PER_TENANT = saved;
    }
  });

  beforeEach(() => truncateAll(ds));

  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.terminate();
  });

  afterAll(async () => {
    await app.close();
    await ds.destroy();
  });

  async function login(apiKey: string): Promise<string> {
    const res = await fetch(app.baseUrl + '/sessions', {
      method: 'POST',
      headers: { 'x-api-key': apiKey },
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { token: string }).token;
  }

  async function ticket(token: string, executionId: string): Promise<string> {
    const res = await fetch(
      `${app.baseUrl}/executions/${executionId}/realtime-tickets`,
      { method: 'POST', headers: { authorization: 'Bearer ' + token } },
    );
    expect(res.status).toBe(201);
    return ((await res.json()) as { ticket: string }).ticket;
  }

  /** Відкриває сокет і повертає результат рукостискання: open або HTTP-статус відмови. */
  function connect(
    value: string,
  ): Promise<{ socket: WebSocket; opened: boolean; status?: number }> {
    const socket = new WebSocket(
      app.baseUrl.replace('http:', 'ws:') + '/realtime?ticket=' + value,
    );
    sockets.push(socket);
    return new Promise((resolve) => {
      socket.once('open', () => resolve({ socket, opened: true }));
      socket.once('unexpected-response', (_req, res) =>
        resolve({ socket, opened: false, status: res.statusCode }),
      );
      socket.once('error', () => resolve({ socket, opened: false }));
    });
  }

  function closed(socket: WebSocket): Promise<number> {
    return new Promise((resolve) =>
      socket.once('close', (code) => resolve(code)),
    );
  }

  async function setup() {
    const { tenant, apiKey } = await createTenant(ds);
    const execution = await createExecution(
      ds,
      await createWorkflow(ds, tenant.id),
    );
    return { tenant, execution, token: await login(apiKey) };
  }

  it('rejects an unknown, an expired and a reused ticket before the upgrade', async () => {
    const { execution, token } = await setup();
    expect(await connect('fft_' + '0'.repeat(64))).toMatchObject({
      opened: false,
      status: 401,
    });

    const expired = await ticket(token, execution.id);
    await ds.query(
      `UPDATE realtime_tickets SET "expiresAt" = clock_timestamp()`,
    );
    expect(await connect(expired)).toMatchObject({
      opened: false,
      status: 401,
    });

    const once = await ticket(token, execution.id);
    expect((await connect(once)).opened).toBe(true);
    expect(await connect(once)).toMatchObject({ opened: false, status: 401 });
  });

  it('enforces the tenant connection limit for parallel handshakes', async () => {
    const { execution, token } = await setup();
    const tickets = await Promise.all(
      Array.from({ length: 6 }, () => ticket(token, execution.id)),
    );
    const results = await Promise.all(tickets.map((t) => connect(t)));
    expect(results.filter((r) => r.opened)).toHaveLength(PER_TENANT);
    const rejected = results.filter((r) => !r.opened);
    expect(rejected).toHaveLength(6 - PER_TENANT);
    for (const r of rejected) expect(r.status).toBe(429);
  });

  it('closes an open socket with 4401 when its session is revoked', async () => {
    const { execution, token } = await setup();
    const { socket, opened } = await connect(await ticket(token, execution.id));
    expect(opened).toBe(true);
    const code = closed(socket);
    const res = await fetch(app.baseUrl + '/sessions/current', {
      method: 'DELETE',
      headers: { authorization: 'Bearer ' + token },
    });
    expect(res.status).toBe(204);
    expect(await code).toBe(4401);
  });

  it('closes the socket with 1003 when the client sends anything', async () => {
    const { execution, token } = await setup();
    const { socket, opened } = await connect(await ticket(token, execution.id));
    expect(opened).toBe(true);
    const code = closed(socket);
    socket.send('{"type":"subscribe"}');
    expect(await code).toBe(1003);
  });
});
