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
 * Черговий цикл і пробудження воркера (docs/architecture.md, «Черговий цикл і пробудження»): у
 * простої опитує один цикл на процес; нову готову роботу воркер бере за підказкою LISTEN, не
 * чекаючи інтервалу; цикли прокидаються ланцюгом, поки є робота; без LISTEN — опитування, як і
 * раніше.
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

  it('polls with one loop while idle and takes a new run at once on the LISTEN hint', async () => {
    const { claims } = await startWorker(LONG_POLL_MS);
    const before = claims.mock.calls.length;
    await sleep(1_000);
    // Чотири цикли без пробудження опитували б кожні 10–30 с кожен; черговий за секунду — ні разу.
    expect(claims.mock.calls.length).toBe(before);

    const id = await run(
      await workflow([{ id: 'say', type: 'log', message: 'hi' }]),
    );
    const started = Date.now();
    await succeeded(id, 3_000);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('wakes the loops in a chain while work lasts, so a burst runs at full concurrency', async () => {
    await startWorker(LONG_POLL_MS);
    let inFlight = 0;
    let peak = 0;
    receiver.respond = async (_req, res) => {
      peak = Math.max(peak, ++inFlight);
      await sleep(400);
      inFlight--;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    };
    const wf = await workflow([
      { id: 'call', type: 'http', method: 'POST', url: receiver.url('/slow') },
    ]);
    const ids = [];
    for (let i = 0; i < 8; i++) ids.push(await run(wf));
    for (const id of ids) await succeeded(id, 5_000);
    expect(peak).toBe(4);
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
    process.env.OUTBOX_POLL_INTERVAL_MS = LONG_POLL_MS;
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
      {
        timeoutMs: 3_000,
      },
    );
  });
});
