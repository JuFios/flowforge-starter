import { DataSource } from 'typeorm';
import type { RunningApp } from '../helpers/app';
import { createTenant, openTestDataSource, truncateAll } from '../helpers/db';
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
  let q: typeof QueueHelpers;
  let receiver: QueueHelpers.Receiver;
  let apiKey: string;
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
      END $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS test_record_retry_delay ON jobs;
      CREATE TRIGGER test_record_retry_delay AFTER UPDATE ON jobs
        FOR EACH ROW EXECUTE FUNCTION test_record_retry_delay();`);
    apiApp = await startApp();
    worker = await q.startWorker(2);
    await receiver.start();
  });

  beforeEach(async () => {
    await truncateAll(ds);
    await ds.query(`TRUNCATE test_retry_delays`);
    ({ apiKey } = await createTenant(ds));
  });

  afterEach(() => {
    receiver.requests.length = 0;
  });

  afterAll(async () => {
    await worker.close();
    await apiApp.close();
    await receiver.stop();
    await ds.query(`
      DROP TRIGGER IF EXISTS test_record_retry_delay ON jobs;
      DROP FUNCTION IF EXISTS test_record_retry_delay();
      DROP TABLE IF EXISTS test_retry_delays;`);
    await ds.destroy();
    if (saved === undefined) delete process.env.JOB_BACKOFF_MAX_MS;
    else process.env.JOB_BACKOFF_MAX_MS = saved;
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
});
