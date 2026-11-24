import { DataSource } from 'typeorm';
import type { RunningApp } from '../helpers/app';
import { createTenant, openTestDataSource, truncateAll } from '../helpers/db';
import { holdTestTable } from '../helpers/hold-test-table';
// Лише тип: модуль хелперів імпортує застосунок, а його конфігурація читається під час імпорту.
import type * as QueueHelpers from '../helpers/queue';

/**
 * Затримка повтору з урахуванням `Retry-After`. Межа backoff тут ширша, ніж в інших тестах
 * (5 с замість 0,5 с), щоб було видно і повагу до заголовка, і обрізання за межею.
 */
const BACKOFF_MAX_MS = 5_000;

describe('Retry-After on 429 and 503', () => {
  let ds: DataSource;
  let apiApp: RunningApp;
  let worker: RunningApp;
  let closeWorker: RunningApp['close'] | undefined;
  let q: typeof QueueHelpers;
  let receiver: QueueHelpers.Receiver;
  let apiKey: string;
  let shutdownProbe: { release(): Promise<void>; pool: DataSource } | undefined;
  const saved = process.env.JOB_BACKOFF_MAX_MS;

  beforeAll(async () => {
    // Оточення читається під час імпорту модуля застосунку, тож імпорт — після налаштування.
    process.env.JOB_BACKOFF_MAX_MS = String(BACKOFF_MAX_MS);
    const { startApp } = await import('../helpers/app');
    q = await import('../helpers/queue');
    receiver = new q.Receiver();
    ds = await openTestDataSource();
    // Затримка кожного повтору — за годинником БД у момент повернення задачі в чергу.
    await ds.query(`
      CREATE TABLE IF NOT EXISTS test_retry_delays ("jobId" uuid, "delayMs" float8);
      CREATE OR REPLACE FUNCTION test_record_retry_delay() RETURNS trigger AS $$
      BEGIN
        IF OLD.status = 'running' AND NEW.status = 'queued' AND NEW."lastError" IS NOT NULL THEN
          INSERT INTO test_retry_delays
            VALUES (NEW.id, EXTRACT(EPOCH FROM NEW."runAt" - now()) * 1000);
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql
      -- Тригер спрацьовує в транзакції воркера (роль без прав на службову таблицю тесту).
      SECURITY DEFINER SET search_path = pg_catalog, public;
      REVOKE ALL ON FUNCTION test_record_retry_delay() FROM PUBLIC;
      DROP TRIGGER IF EXISTS test_record_retry_delay ON jobs;
      CREATE TRIGGER test_record_retry_delay AFTER UPDATE ON jobs
        FOR EACH ROW EXECUTE FUNCTION test_record_retry_delay();`);
    apiApp = await startApp();
    await receiver.start();
  });

  beforeEach(async () => {
    if (closeWorker)
      throw new Error('the previous worker fixture is still running');
    await truncateAll(ds);
    await ds.query(`TRUNCATE test_retry_delays`);
    ({ apiKey } = await createTenant(ds));
    worker = await q.startWorker(2);
    closeWorker = worker.close;
  });

  async function stopWorker() {
    await closeWorker?.();
    closeWorker = undefined;
  }

  afterEach(async () => {
    const probe = shutdownProbe;
    shutdownProbe = undefined;
    await Promise.all([stopWorker(), probe?.release()]);
    if (probe) expect(probe.pool.isInitialized).toBe(false);
    receiver.requests.length = 0;
  });

  afterAll(async () => {
    try {
      await stopWorker();
      await ds.query(`
        DROP TRIGGER IF EXISTS test_record_retry_delay ON jobs;
        DROP FUNCTION IF EXISTS test_record_retry_delay();
        DROP TABLE IF EXISTS test_retry_delays;`);
    } finally {
      try {
        await Promise.all([apiApp?.close(), receiver?.stop(), ds?.destroy()]);
      } finally {
        if (saved === undefined) delete process.env.JOB_BACKOFF_MAX_MS;
        else process.env.JOB_BACKOFF_MAX_MS = saved;
      }
    }
  });

  /** Перша спроба відповідає `status` з `Retry-After`, наступні — 200. Повертає затримку повтору. */
  async function firstRetryDelay(
    status: number,
    retryAfter: string,
  ): Promise<number> {
    receiver.respond = (req, res) => {
      if (receiver.hits(req.path).length === 1)
        return void res.writeHead(status, { 'retry-after': retryAfter }).end();
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    };
    const wf = await q.api<{ id: string }>(
      apiApp.baseUrl,
      apiKey,
      'POST',
      '/workflows',
      {
        name: 'ra',
        steps: [{ id: 'call', type: 'http', url: receiver.url('/ra') }],
      },
    );
    await q.api(
      apiApp.baseUrl,
      apiKey,
      'POST',
      `/workflows/${wf.body.id}/run`,
      {},
    );
    let delay: number | undefined;
    await q.waitFor('the first retry to be scheduled', async () => {
      const rows: Array<{ delayMs: number }> = await ds.query(
        `SELECT "delayMs" FROM test_retry_delays`,
      );
      delay = rows[0]?.delayMs;
      return delay !== undefined;
    });
    return delay!;
  }

  it.each([429, 503])(
    'waits at least as long as HTTP %i asks in seconds',
    async (status) => {
      const delay = await firstRetryDelay(status, '2');
      expect(delay).toBeGreaterThanOrEqual(2_000);
      expect(delay).toBeLessThanOrEqual(BACKOFF_MAX_MS);
    },
  );

  it('accepts Retry-After as an HTTP date', async () => {
    const at = new Date(Date.now() + 4_000).toUTCString();
    const delay = await firstRetryDelay(503, at);
    // HTTP-date має точність до секунди: щонайменше ~3 с.
    expect(delay).toBeGreaterThanOrEqual(2_900);
    expect(delay).toBeLessThanOrEqual(BACKOFF_MAX_MS);
  });

  it('never waits longer than the backoff cap, whatever the receiver asks', async () => {
    const delay = await firstRetryDelay(429, '86400');
    expect(delay).toBeLessThanOrEqual(BACKOFF_MAX_MS);
    expect(delay).toBeGreaterThanOrEqual(BACKOFF_MAX_MS - 500);
  });

  it('ignores Retry-After on other statuses', async () => {
    // 500 з Retry-After: звичайний backoff першої спроби — до base·2 = 100 мс.
    const delay = await firstRetryDelay(500, '3');
    expect(delay).toBeLessThanOrEqual(200);
  });

  it('ends the worker fixture even if the next due work query is still in Postgres', async () => {
    const pool = worker.app.get(DataSource);
    const gate = await holdTestTable(ds, 'notification_settings');
    try {
      await gate.waitForQuery('SELECT * FROM next_due_work()');
      shutdownProbe = { release: gate.release, pool };
    } finally {
      if (!shutdownProbe) await gate.release();
    }
  });
});
