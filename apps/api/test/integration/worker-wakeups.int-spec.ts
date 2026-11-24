import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { Execution } from '../../src/entities';
import { RunningApp, startApp } from '../helpers/app';
import { createTenant, openTestDataSource, truncateAll } from '../helpers/db';
import { configureNotifications } from '../helpers/notifications';
import { api, Receiver, sleep, waitFor } from '../helpers/queue';

/** Інтервал опитування, за який жоден із тестів не встиг би без пробудження. */
const LONG_POLL_MS = '20000';

/**
 * Пробудження воркера (docs/architecture.md, «Пробудження воркера»): кожен цикл опитує чергу зі
 * своїм інтервалом, як і без підказок; нову готову задачу чи подію воркер бере за підказкою LISTEN,
 * не чекаючи інтервалу, і підказка будить один цикл; без LISTEN — опитування.
 */
describe('worker wake-ups', () => {
  let ds: DataSource;
  let apiApp: RunningApp;
  let worker: RunningApp | undefined;
  const receiver = new Receiver();
  let apiKey: string;
  const saved = {
    WORKER_POLL_INTERVAL_MS: process.env.WORKER_POLL_INTERVAL_MS,
    OUTBOX_POLL_INTERVAL_MS: process.env.OUTBOX_POLL_INTERVAL_MS,
  };

  beforeAll(async () => {
    ds = await openTestDataSource();
    apiApp = await startApp(AppModule);
    await receiver.start();
  });

  beforeEach(async () => {
    await truncateAll(ds);
    ({ apiKey } = await createTenant(ds));
  });

  afterEach(async () => {
    await worker?.close();
    worker = undefined;
    Object.assign(process.env, saved);
    receiver.requests.length = 0;
    receiver.respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    };
  });

  afterAll(async () => {
    await apiApp.close();
    await receiver.stop();
    await ds.destroy();
  });

  /**
   * Воркер із заданими інтервалами опитування; повертається, коли LISTEN встановлено. Конфігурацію
   * Nest читає під час імпорту модуля, тож воркер — з окремого реєстру модулів із новим оточенням.
   */
  async function startWorker(pollMs: string, loops = 4) {
    process.env.WORKER_POLL_INTERVAL_MS = pollMs;
    process.env.OUTBOX_POLL_INTERVAL_MS = pollMs;
    let services!: {
      runner: { start(n: number): void };
      outbox: { start(n: number): void };
      signals: { listening: boolean; stop(): Promise<void> };
      claims: jest.SpyInstance;
    };
    await jest.isolateModulesAsync(async () => {
      const { startApp: start } = await import('../helpers/app');
      const mod = await import('../../src/app.module');
      const runner = await import('../../src/engine/job-runner.service');
      const signals = await import('../../src/engine/work-signals.service');
      const outbox = await import('../../src/outbox/outbox-sender.service');
      const system = await import('../../src/tenancy/system-db');
      worker = await start(mod.WorkerModule);
      services = {
        runner: worker.app.get(runner.JobRunnerService),
        outbox: worker.app.get(outbox.OutboxSender),
        signals: worker.app.get(signals.WorkSignals),
        claims: jest.spyOn(worker.app.get(system.SystemDb), 'claimJob'),
      };
    });
    const { claims, signals } = services;
    services.runner.start(loops);
    await waitFor('worker LISTEN', () => signals.listening);
    // Початкові захоплення всіх циклів (черга порожня) завершились.
    await waitFor('initial claims', () => claims.mock.calls.length >= loops);
    await sleep(200);
    return services;
  }

  async function workflow(steps: unknown[]): Promise<string> {
    const res = await api<{ id: string }>(
      apiApp.baseUrl,
      apiKey,
      'POST',
      '/workflows',
      { name: 'wake', steps },
    );
    expect(res.status).toBe(201);
    return res.body.id;
  }

  async function run(workflowId: string): Promise<string> {
    const res = await api<{ id: string }>(
      apiApp.baseUrl,
      apiKey,
      'POST',
      `/workflows/${workflowId}/run`,
      {},
    );
    expect(res.status).toBe(201);
    return res.body.id;
  }

  async function succeeded(id: string, timeoutMs: number) {
    await waitFor(
      `execution ${id} succeeded`,
      async () =>
        (await ds.getRepository(Execution).findOneByOrFail({ id })).status ===
        'succeeded',
      { timeoutMs },
    );
  }

  it('keeps the idle polling of every loop as without hints', async () => {
    const pollMs = 400;
    const loops = 4;
    const { claims } = await startWorker(String(pollMs), loops);
    const before = claims.mock.calls.length;
    const windowMs = 4_000;
    await sleep(windowMs);
    // Кожен цикл спить інтервал із відхиленням ±50% (у середньому pollMs): ні частіше, ні рідше.
    const expected = (loops * windowMs) / pollMs;
    const polls = claims.mock.calls.length - before;
    expect(polls).toBeGreaterThanOrEqual(expected * 0.6);
    expect(polls).toBeLessThanOrEqual(expected * 1.4);
  });

  it('takes a new run at once on the LISTEN hint and wakes a single loop for it', async () => {
    const { claims } = await startWorker(LONG_POLL_MS);
    const wf = await workflow([{ id: 'say', type: 'log', message: 'hi' }]);
    const before = claims.mock.calls.length;
    const started = Date.now();
    const id = await run(wf);
    // Без підказки цикли спали б 10–30 с.
    await succeeded(id, 3_000);
    expect(Date.now() - started).toBeLessThan(3_000);
    await sleep(300);
    // Розбуджений цикл: захоплення задачі й порожнє після неї. Решта циклів не прокидались.
    expect(claims.mock.calls.length - before).toBeLessThanOrEqual(2);
  });

  it('still picks work up by polling when the LISTEN connection is gone', async () => {
    const { signals } = await startWorker('300');
    await signals.stop();
    const id = await run(
      await workflow([{ id: 'say', type: 'log', message: 'hi' }]),
    );
    await succeeded(id, 3_000);
  });

  it('delivers a new notification at once on the LISTEN hint', async () => {
    await configureNotifications(apiApp, apiKey, receiver.url('/hook'));
    const { signals, outbox } = await startWorker(LONG_POLL_MS, 1);
    outbox.start(2);
    await waitFor('LISTEN still up', () => signals.listening);
    await sleep(300);
    const id = await run(
      await workflow([{ id: 'say', type: 'log', message: 'hi' }]),
    );
    await succeeded(id, 3_000);
    await waitFor(
      'notification delivered',
      () => receiver.hits('/hook').length === 1,
      { timeoutMs: 3_000 },
    );
  });
});
