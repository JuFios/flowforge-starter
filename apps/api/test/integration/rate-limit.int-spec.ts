import { signedHeaders } from '../helpers/webhook';
import { DataSource } from 'typeorm';
import { LimitsMetrics } from '../../src/limits/limits.metrics';
import { RateLimitPurger } from '../../src/limits/rate-limit.purger';
import { RunningApp, startApp } from '../helpers/app';
import { createTenant, openTestDataSource, truncateAll } from '../helpers/db';
import { sleep, waitFor } from '../helpers/queue';
import { provisionTestDatabase } from '../helpers/test-provision';

/**
 * Ліміт частоти запитів тенанта (ТЗ 3.3.4): фіксоване вікно в Postgres, спільне для всіх
 * інстансів API; одна квота на всі маршрути тенанта, окрема — на його webhook-и. Ліміти за IP
 * (адмін-ендпоінти, невдалі автентифікації) — rate-limit-ip.int-spec.
 */
describe('tenant request rate limit', () => {
  let owner: DataSource;
  let apiA: RunningApp;
  let apiB: RunningApp;
  let tenant: { id: string; apiKey: string; webhookSecret: string };

  beforeAll(async () => {
    owner = await openTestDataSource();
    [apiA, apiB] = [await startApp(), await startApp()];
  });

  beforeEach(async () => {
    await truncateAll(owner);
    const created = await createTenant(owner);
    tenant = {
      id: created.tenant.id,
      apiKey: created.apiKey,
      webhookSecret: created.tenant.webhookSecret,
    };
  });

  afterAll(async () => {
    await apiA.close();
    await apiB.close();
    await truncateAll(owner);
    await owner.destroy();
  });

  const limit = (column: 'rateLimit' | 'webhookRateLimit', value: number) =>
    owner.query(`UPDATE tenants SET "${column}" = $2 WHERE id = $1`, [
      tenant.id,
      value,
    ]);

  const get = (path: string, app = apiA) =>
    fetch(`${app.baseUrl}${path}`, { headers: { 'x-api-key': tenant.apiKey } });

  async function workflow(): Promise<string> {
    const res = await fetch(`${apiA.baseUrl}/workflows`, {
      method: 'POST',
      headers: {
        'x-api-key': tenant.apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'w',
        steps: [{ id: 'say', type: 'log', message: 'hi' }],
      }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  function hook(wf: string, body: unknown, secret = tenant.webhookSecret) {
    return fetch(`${apiA.baseUrl}/hooks/${wf}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...signedHeaders(wf, secret, JSON.stringify(body)),
      },
      body: JSON.stringify(body),
    });
  }

  it('sends the limit headers on every response and 429 rate_limited with Retry-After past the limit', async () => {
    await limit('rateLimit', 3);
    for (let i = 0; i < 3; i++) {
      const res = await get('/workflows');
      expect(res.status).toBe(200);
      expect(res.headers.get('x-ratelimit-limit')).toBe('3');
      expect(res.headers.get('x-ratelimit-remaining')).toBe(String(2 - i));
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      expect(reset).toBeGreaterThan(0);
      expect(reset).toBeLessThanOrEqual(60);
    }
    const res = await get('/workflows');
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({
      statusCode: 429,
      error: 'rate_limited',
    });
    expect(res.headers.get('x-ratelimit-remaining')).toBe('0');
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    const { values } = await apiA.app.get(LimitsMetrics).rateLimited.get();
    expect(values.find((v) => v.labels.throttler === 'tenant')?.value).toBe(1);
  });

  it('shares one quota between all routes of the tenant and between API instances', async () => {
    await limit('rateLimit', 4);
    expect((await get('/workflows', apiA)).status).toBe(200);
    expect((await get('/executions', apiB)).status).toBe(200);
    expect((await get('/workflows', apiB)).status).toBe(200);
    expect((await get('/executions', apiA)).status).toBe(200);
    expect((await get('/workflows', apiB)).status).toBe(429);
    expect((await get('/executions', apiA)).status).toBe(429);
  });

  it('admits exactly the limit out of 30 concurrent requests to two instances', async () => {
    await limit('rateLimit', 10);
    const statuses = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        get('/workflows', i % 2 ? apiA : apiB).then((r) => r.status),
      ),
    );
    expect(statuses.filter((s) => s === 200)).toHaveLength(10);
    expect(statuses.filter((s) => s === 429)).toHaveLength(20);
  });

  it('does not limit another tenant and starts a new window when the old one ends', async () => {
    // Найкоротше вікно за контрактом — 1 с (значення за замовчуванням, спільне для тенантів).
    await owner.query(`UPDATE limit_defaults SET "rateWindowMs" = 1000`);
    try {
      await limit('rateLimit', 1);
      const other = await createTenant(owner, 'other');
      expect((await get('/workflows')).status).toBe(200);
      expect((await get('/workflows')).status).toBe(429);
      expect(
        (
          await fetch(`${apiA.baseUrl}/workflows`, {
            headers: { 'x-api-key': other.apiKey },
          })
        ).status,
      ).toBe(200);
      await sleep(1_100);
      expect((await get('/workflows')).status).toBe(200);
    } finally {
      await provisionTestDatabase(owner);
    }
  });

  it('counts webhooks in their own quota, only after a valid signature and for the tenant of the target', async () => {
    const wf = await workflow();
    await limit('rateLimit', 1);
    await limit('webhookRateLimit', 2);
    // Квота API вичерпана — webhook-и цього тенанта рахуються окремо.
    expect((await get('/workflows')).status).toBe(429);
    // Невірний підпис: 401, квоту webhook-ів не витрачає.
    for (let i = 0; i < 3; i++)
      expect((await hook(wf, { i }, 'wrong-secret')).status).toBe(401);
    expect((await hook(wf, { n: 1 })).status).toBe(202);
    const second = await hook(wf, { n: 2 });
    expect(second.status).toBe(202);
    expect(second.headers.get('x-ratelimit-limit')).toBe('2');
    expect(second.headers.get('x-ratelimit-remaining')).toBe('0');
    const third = await hook(wf, { n: 3 });
    expect(third.status).toBe(429);
    expect(await third.json()).toMatchObject({ error: 'rate_limited' });
  });

  it('does not limit the health endpoints', async () => {
    await limit('rateLimit', 1);
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${apiA.baseUrl}/health`);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-ratelimit-limit')).toBeNull();
    }
  });

  it('fails the request instead of skipping the limit when the counter is unavailable', async () => {
    await owner.query(
      `ALTER FUNCTION rate_limit_hit(text, integer, integer) RENAME TO rate_limit_hit_off`,
    );
    try {
      const res = await get('/workflows');
      expect(res.status).toBe(500);
    } finally {
      await owner.query(
        `ALTER FUNCTION rate_limit_hit_off(text, integer, integer) RENAME TO rate_limit_hit`,
      );
    }
    expect((await get('/workflows')).status).toBe(200);
  });

  // Запит, що чекав на рядок відра довше за залишок вікна, рахується вже в новому вікні: інакше
  // клієнт отримав би 429 з додатним Retry-After, хоча нове вікно вже почалося.
  it.each(['commit', 'rollback'])(
    'starts a fresh window after a concurrent insert ends with %s',
    async (outcome) => {
      const key = 'lock-wait-window';
      const runner = owner.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      // Обробник результату — одразу: помилка виклику під час очікування не стає необробленою.
      let waited:
        | Promise<
            | { rows: Array<{ hits: number; resetMs: number }> }
            | { error: unknown }
          >
        | undefined;
      try {
        await runner.query(`SELECT * FROM rate_limit_hit($1, 300, 1)`, [key]);
        waited = owner
          .query(`SELECT hits, "resetMs" FROM rate_limit_hit($1, 300, 1)`, [
            key,
          ])
          .then(
            (rows: Array<{ hits: number; resetMs: number }>) => ({ rows }),
            (error: unknown) => ({ error }),
          );
        // Другий виклик справді чекає на вставку першої транзакції, а не стартує вже після неї.
        await waitFor('the second hit to wait for the bucket', async () => {
          const rows: unknown[] = await owner.query(
            `SELECT 1 FROM pg_stat_activity
              WHERE wait_event_type = 'Lock' AND query LIKE '%rate_limit_hit%'
                AND pid <> pg_backend_pid()`,
          );
          return rows.length > 0;
        });
        await sleep(500);
      } finally {
        if (outcome === 'rollback') await runner.rollbackTransaction();
        else await runner.commitTransaction();
        await runner.release();
      }
      const result = await waited;
      if (!result || 'error' in result) throw result?.error;
      const [row] = result.rows;
      expect(row.hits).toBe(1);
      expect(row.resetMs).toBeGreaterThan(200);
      expect(row.resetMs).toBeLessThanOrEqual(300);
    },
  );

  it('purges buckets whose window has ended and keeps the current ones', async () => {
    expect((await get('/workflows')).status).toBe(200);
    await owner.query(
      `INSERT INTO rate_limit_buckets (key, hits, "resetAt")
       SELECT 'old:' || g, 1, now() - interval '1 minute' FROM generate_series(1, 1500) g`,
    );
    expect(await apiA.app.get(RateLimitPurger).purge()).toBe(1500);
    const [{ left }]: Array<{ left: number }> = await owner.query(
      `SELECT count(*)::int AS left FROM rate_limit_buckets`,
    );
    expect(left).toBe(1);
  });
});
