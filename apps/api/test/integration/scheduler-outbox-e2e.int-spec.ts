import { ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { WorkerModule } from '../../src/app.module';
import { OutboxSender } from '../../src/outbox/outbox-sender.service';
import { SchedulerService } from '../../src/scheduler/scheduler.service';
import { RunningApp, startApp } from '../helpers/app';
import { createTenant, openTestDataSource, truncateAll } from '../helpers/db';
import {
  configureNotifications,
  verifyNotification,
} from '../helpers/notifications';
import { api, Receiver, sleep, startWorker, waitFor } from '../helpers/queue';
import { testWorkerDatabaseUrl } from '../helpers/test-env';

const WORKER_ENTRY = join(__dirname, '../../dist/worker.js');

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

interface ExecutionRow {
  id: string;
  status: string;
  scheduledAt: Date;
  correlationId: string;
}

/**
 * Наскрізний прогін на реальному PostgreSQL (ТЗ 3.3.8–3.3.10): два інстанси API з планувальниками,
 * воркер окремим процесом (задачі й відправник) і ще один відправник, керований отримувач.
 * Збіг розкладу дає одне виконання, завершення — одну подію, а втрачене підтвердження — повторну
 * підписану доставку з тим самим ID і тими самими байтами. Один кореляційний ID видно від
 * спрацювання до вихідного запиту кроку й до доставки події.
 */
describe('scheduler, worker and outbox end to end', () => {
  let ds: DataSource;
  let schedulers: RunningApp[] = [];
  let sender: RunningApp | undefined;
  let worker: RunningApp | undefined;
  let child: ChildProcess | undefined;
  const receiver = new Receiver();

  beforeAll(async () => {
    if (!existsSync(WORKER_ENTRY))
      throw new Error(`${WORKER_ENTRY} is missing: run npm run build first`);
    ds = await openTestDataSource();
    await truncateAll(ds);
    await receiver.start();
  });
  afterEach(async () => {
    child?.kill('SIGKILL');
    child = undefined;
    await sender?.close();
    sender = undefined;
    await worker?.close();
    worker = undefined;
    for (const app of schedulers) await app.close();
    schedulers = [];
  });
  afterAll(async () => {
    await receiver.stop();
    await truncateAll(ds);
    await ds.destroy();
  });

  it('fires once per moment, sends one event per completion and redelivers it with the same id after a lost acknowledgement', async () => {
    schedulers = [await startApp(), await startApp()];
    // Обидва планувальники тікають одночасно й часто (конфігурацію ConfigModule читає під час
    // імпорту модуля, тож інтервал задає тест): збіг моменту між ними гарантований.
    const ticking = schedulers.map((app) => {
      const scheduler = app.app.get(SchedulerService);
      scheduler.onApplicationShutdown();
      return scheduler;
    });
    let stop = false;
    const ticker = (async () => {
      while (!stop) {
        await Promise.all(ticking.map((s) => s.tick()));
        await sleep(150);
      }
    })();
    const { apiKey } = await createTenant(ds);
    const { secret } = await configureNotifications(
      schedulers[0],
      apiKey,
      receiver.url('/events'),
    );
    const delivered = new Set<string>();
    receiver.respond = (req, res) => {
      if (req.path === '/events') {
        const id = String(req.headers['x-flowforge-event-id']);
        // Перша доставка кожної події прийнята, але підтвердження губиться.
        if (!delivered.has(id)) {
          delivered.add(id);
          res.socket?.destroy();
          return;
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    };
    // Воркер — окремий процес із роллю воркера: задачі й відправник; другий відправник — тут.
    child = spawn(process.execPath, [WORKER_ENTRY], {
      env: {
        ...process.env,
        DATABASE_URL: testWorkerDatabaseUrl(),
        WORKER_HTTP_PORT: String(await freePort()),
        WORKER_CONCURRENCY: '2',
        OUTBOX_CONCURRENCY: '1',
      },
      stdio: 'ignore',
    });
    sender = await startApp(WorkerModule);
    sender.app.get(OutboxSender).start(1);

    const wf = await api<{ id: string }>(
      schedulers[1].baseUrl,
      apiKey,
      'POST',
      '/workflows',
      {
        name: 'e2e',
        cron: '*/2 * * * * *',
        steps: [
          { id: 'call', type: 'http', url: receiver.url('/step') },
          { id: 'say', type: 'log', message: 'done' },
        ],
      },
    );
    expect(wf.status).toBe(201);
    const executions = (): Promise<ExecutionRow[]> =>
      ds.query(
        `SELECT id, status, "scheduledAt", "correlationId" FROM executions
          WHERE "workflowId" = $1 ORDER BY "scheduledAt"`,
        [wf.body.id],
      );
    await waitFor(
      'the first scheduled event to be delivered',
      async () => {
        const [first] = await executions();
        if (!first) return false;
        const rows: unknown[] = await ds.query(
          `SELECT 1 FROM outbox_events WHERE "executionId" = $1 AND status = 'delivered'`,
          [first.id],
        );
        return rows.length === 1;
      },
      { timeoutMs: 30_000 },
    );
    // Зупинити нові спрацювання: тікер дописує свій поточний тік і виходить.
    stop = true;
    await ticker;

    const all = await executions();
    // Одне виконання на момент, моменти — розкладу (кожні 2 с), без пропусків між ними.
    const times = all.map((e) => e.scheduledAt.getTime());
    expect(new Set(times).size).toBe(times.length);
    for (const t of times) expect(t % 2_000).toBe(0);
    for (let i = 1; i < times.length; i++)
      expect(times[i] - times[i - 1]).toBe(2_000);

    const [first] = all;
    expect(first.correlationId).toBe(`cron:${wf.body.id}:${times[0]}`);
    expect(first.status).toBe('succeeded');
    // Вихідний запит кроку несе кореляційний ID спрацювання.
    const steps = receiver
      .hits('/step')
      .filter((r) => r.headers['x-request-id'] === first.correlationId);
    expect(steps).toHaveLength(1);

    const events: Array<{
      id: string;
      payload: string;
      status: string;
      correlationId: string;
    }> = await ds.query(
      'SELECT id, payload, status, "correlationId" FROM outbox_events WHERE "executionId" = $1',
      [first.id],
    );
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event.correlationId).toBe(first.correlationId);
    const hits = receiver
      .hits('/events')
      .filter((r) => r.headers['x-flowforge-event-id'] === event.id);
    // Втрачене підтвердження: щонайменше дві доставки тієї самої події, побайтово однакові.
    expect(hits.length).toBeGreaterThanOrEqual(2);
    for (const h of hits) {
      expect(h.raw.equals(Buffer.from(event.payload, 'utf8'))).toBe(true);
      expect(verifyNotification(h.headers, h.raw, secret)).toBe(true);
      expect(h.headers['x-request-id']).toBe(first.correlationId);
    }
    expect(hits.map((h) => h.headers['x-flowforge-attempt'])).toEqual(
      hits.map((_h, i) => String(i + 1)),
    );
    expect(JSON.parse(event.payload)).toMatchObject({
      id: event.id,
      type: 'execution.succeeded',
      correlationId: first.correlationId,
      data: {
        executionId: first.id,
        trigger: 'cron',
        scheduledAt: first.scheduledAt.toISOString(),
        status: 'succeeded',
      },
    });
    const attempts: Array<{ outcome: string }> = await ds.query(
      'SELECT outcome FROM outbox_attempts WHERE "eventId" = $1 ORDER BY attempt',
      [event.id],
    );
    expect(attempts[0].outcome).toBe('network');
    expect(attempts[attempts.length - 1].outcome).toBe('delivered');
  });

  it('carries the correlation id of an API request to the step request and the delivery of its event', async () => {
    schedulers = [await startApp()];
    const { apiKey } = await createTenant(ds);
    await configureNotifications(
      schedulers[0],
      apiKey,
      receiver.url('/api-events'),
    );
    receiver.respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    };
    worker = await startWorker();
    worker.app.get(OutboxSender).start(1);
    const wf = await api<{ id: string }>(
      schedulers[0].baseUrl,
      apiKey,
      'POST',
      '/workflows',
      {
        name: 'traced',
        steps: [{ id: 'call', type: 'http', url: receiver.url('/api-step') }],
      },
    );
    const res = await fetch(
      `${schedulers[0].baseUrl}/workflows/${wf.body.id}/run`,
      {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'content-type': 'application/json',
          'x-request-id': 'trace-e2e-42',
        },
        body: '{}',
      },
    );
    expect(res.headers.get('x-request-id')).toBe('trace-e2e-42');
    const { id } = (await res.json()) as { id: string };
    await waitFor(
      'the event to be delivered',
      () => receiver.hits('/api-events').length > 0,
    );
    const [execution]: Array<{ correlationId: string }> = await ds.query(
      'SELECT "correlationId" FROM executions WHERE id = $1',
      [id],
    );
    const [job]: Array<{ correlationId: string }> = await ds.query(
      'SELECT "correlationId" FROM jobs WHERE "executionId" = $1',
      [id],
    );
    const [event]: Array<{ correlationId: string }> = await ds.query(
      'SELECT "correlationId" FROM outbox_events WHERE "executionId" = $1',
      [id],
    );
    expect([execution, job, event].map((r) => r.correlationId)).toEqual([
      'trace-e2e-42',
      'trace-e2e-42',
      'trace-e2e-42',
    ]);
    expect(receiver.hits('/api-step')[0].headers['x-request-id']).toBe(
      'trace-e2e-42',
    );
    expect(receiver.hits('/api-events')[0].headers['x-request-id']).toBe(
      'trace-e2e-42',
    );
  });
});
