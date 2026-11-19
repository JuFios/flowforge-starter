import { DataSource } from 'typeorm';
import { Execution, Job, StepRun } from '../../src/entities';
import type { RunningApp } from '../helpers/app';
import { createTenant, openTestDataSource, truncateAll } from '../helpers/db';
// Лише тип: модуль хелперів імпортує застосунок, а його конфігурація читається під час імпорту.
import type * as QueueHelpers from '../helpers/queue';

const CONCURRENCY = 64;
/** Розмір пулу, який задає конфігурація: по з'єднанню на цикл і запас на heartbeat/reaper. */
const POOL_SIZE = CONCURRENCY + 4;

/**
 * Пул з'єднань воркера при найбільшій кількості циклів (64). Heartbeat, чекпоінти й опитування
 * черги ділять пул, а очікування з'єднання обмежене DB_CONNECT_TIMEOUT_MS. Кожен крок утричі
 * довший за lease (1,5 с у тестах), тож lease мусить продовжуватися весь час.
 */
describe('connection pool under the largest worker concurrency', () => {
  let ds: DataSource;
  let apiApp: RunningApp;
  let worker: RunningApp | undefined;
  let q: typeof QueueHelpers;
  let receiver: QueueHelpers.Receiver;
  let apiKey: string;
  const saved = {
    WORKER_CONCURRENCY: process.env.WORKER_CONCURRENCY,
    DB_POOL_SIZE: process.env.DB_POOL_SIZE,
  };

  beforeAll(async () => {
    // Оточення читається під час імпорту модуля застосунку, тож імпорт — після налаштування.
    process.env.WORKER_CONCURRENCY = String(CONCURRENCY);
    process.env.DB_POOL_SIZE = String(POOL_SIZE);
    q = await import('../helpers/queue');
    const { startApp } = await import('../helpers/app');
    const { AppModule } = await import('../../src/app.module');
    ds = await openTestDataSource();
    apiApp = await startApp(AppModule);
    receiver = new q.Receiver();
    await receiver.start();
  });

  beforeEach(async () => {
    await truncateAll(ds);
    ({ apiKey } = await createTenant(ds));
    receiver.respond = async (_req, res) => {
      await q.sleep(4_500);
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    };
  });

  afterEach(async () => {
    await worker?.close();
    worker = undefined;
    receiver.requests.length = 0;
    await ds.query(`DROP TRIGGER IF EXISTS test_slow_jobs ON jobs`);
    await ds.query(`DROP FUNCTION IF EXISTS test_slow_jobs()`);
  });

  afterAll(async () => {
    await apiApp.close();
    await receiver.stop();
    await ds.destroy();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function runAll(): Promise<void> {
    const wf = await q.api<{ id: string }>(
      apiApp.baseUrl,
      apiKey,
      'POST',
      '/workflows',
      {
        name: 'pool',
        steps: [
          { id: 'call', type: 'http', url: receiver.url('/slow') },
          { id: 'after', type: 'log', message: 'done' },
        ],
      },
    );
    for (let i = 0; i < CONCURRENCY; i++)
      await q.api(
        apiApp.baseUrl,
        apiKey,
        'POST',
        `/workflows/${wf.body.id}/run`,
        { i },
      );
    const { startApp } = await import('../helpers/app');
    const { WorkerModule } = await import('../../src/app.module');
    const { JobRunnerService } =
      await import('../../src/engine/job-runner.service');
    worker = await startApp(WorkerModule, { captureLogs: true });
    // Кількість циклів — з конфігурації (WORKER_CONCURRENCY), як у справжньому воркері.
    worker.app.get(JobRunnerService).start();
    await q.waitFor(
      'every execution to finish',
      async () =>
        (await ds
          .getRepository(Execution)
          .countBy([{ status: 'succeeded' }, { status: 'failed' }])) ===
        CONCURRENCY,
      { timeoutMs: 60_000, intervalMs: 200 },
    );
  }

  async function expectNoLeaseLost(): Promise<void> {
    expect(
      await ds.getRepository(Execution).countBy({ status: 'succeeded' }),
    ).toBe(CONCURRENCY);
    expect(receiver.hits('/slow')).toHaveLength(CONCURRENCY);
    const jobs = await ds.getRepository(Job).find();
    expect(
      jobs.filter((j) => j.attempts !== 1 || j.lastError !== null),
    ).toEqual([]);
    const steps = await ds.getRepository(StepRun).find();
    expect(steps.filter((s) => s.attempts !== 1)).toEqual([]);
    const leaseTrouble = worker!.logs.filter((l) =>
      /lease|claim failed|processing failed/.test(String(l.msg)),
    );
    expect(leaseTrouble.map((l) => l.msg)).toEqual([]);
  }

  it('keeps every lease while 64 long steps run at once', async () => {
    await runAll();
    await expectNoLeaseLost();
  }, 90_000);

  it('keeps every lease when each job update holds its connection for 150 ms', async () => {
    // Повільна БД: кожне оновлення рядка задачі (захоплення, heartbeat, чекпоінт) тримає
    // з'єднання 150 мс. З пулом pg за замовчуванням (10) heartbeat-и стоять у черзі пулу позаду
    // опитувань 64 циклів, і lease-и минають.
    await ds.query(`
      CREATE FUNCTION test_slow_jobs() RETURNS trigger AS $$
      BEGIN PERFORM pg_sleep(0.15); RETURN NEW; END $$ LANGUAGE plpgsql;
      REVOKE ALL ON FUNCTION test_slow_jobs() FROM PUBLIC;
      CREATE TRIGGER test_slow_jobs BEFORE UPDATE ON jobs
        FOR EACH ROW EXECUTE FUNCTION test_slow_jobs();`);
    await runAll();
    await expectNoLeaseLost();
  }, 90_000);
});
