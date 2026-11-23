import { request } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { DataSource } from 'typeorm';
import type { RunningApp } from '../helpers/app';
import {
  createExecution,
  createTenant,
  createWorkflow,
  openTestDataSource,
  truncateAll,
} from '../helpers/db';
import { waitFor } from '../helpers/queue';

/** Знімок тенанта: великий (8 кроків по ~1 МБ) не вміщується в буфери сокета й тримає віддачу. */
async function execution(ds: DataSource, big: boolean) {
  const { tenant, apiKey } = await createTenant(ds);
  const e = await createExecution(ds, await createWorkflow(ds, tenant.id));
  if (big)
    await ds.query(
      `INSERT INTO step_runs ("executionId","tenantId","stepIndex","stepId",status,attempts,output)
       SELECT $1, $2, i, 's' || i, 'succeeded', 1,
              jsonb_build_object('body', repeat('x', 1000000))
         FROM generate_series(0, 7) AS i`,
      [e.id, tenant.id],
    );
  return { apiKey, id: e.id };
}

/** Запит деталей, тіло якого клієнт не читає: віддача стоїть на зворотному тиску. */
function slowGet(
  app: RunningApp,
  apiKey: string,
  id: string,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = request(`${app.baseUrl}/executions/${id}`, {
      headers: { 'x-api-key': apiKey },
    });
    req.on('response', (res) => {
      res.pause();
      resolve(res);
    });
    req.on('error', reject);
    req.end();
  });
}

function detail(app: RunningApp, apiKey: string, id: string) {
  return fetch(`${app.baseUrl}/executions/${id}`, {
    headers: { 'x-api-key': apiKey },
  });
}

/** Статус відповіді деталей; тіло скасовується, щоб віддача не тримала місце в пулі. */
async function detailStatus(app: RunningApp, apiKey: string, id: string) {
  const res = await detail(app, apiKey, id);
  await res.body?.cancel();
  return res.status;
}

/**
 * Застосунок зі змінними DETAIL_*: конфігурація читається під час імпорту модуля, тож — в
 * ізольованому реєстрі модулів.
 */
async function startWith(env: Record<string, string>): Promise<RunningApp> {
  const saved = Object.fromEntries(
    Object.keys(env).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, env);
  try {
    let app: RunningApp | undefined;
    await jest.isolateModulesAsync(async () => {
      const { startApp } = await import('../helpers/app');
      app = await startApp();
    });
    return app!;
  } finally {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
}

describe('execution details share the API instance fairly between tenants', () => {
  let ds: DataSource;
  const responses: IncomingMessage[] = [];

  beforeAll(async () => {
    ds = await openTestDataSource();
  });
  beforeEach(() => truncateAll(ds));
  afterEach(() => {
    for (const res of responses.splice(0)) res.destroy();
  });
  afterAll(() => ds.destroy());

  describe('with the default limits', () => {
    let app: RunningApp;
    beforeAll(async () => {
      app = await startWith({});
    });
    afterAll(() => app.close());

    it('serves another tenant while two tenants read their details slowly', async () => {
      const a = await execution(ds, true);
      const b = await execution(ds, true);
      const c = await execution(ds, false);
      for (const t of [a, b]) {
        const res = await slowGet(app, t.apiKey, t.id);
        responses.push(res);
        expect(res.statusCode).toBe(200);
      }
      const res = await detail(app, c.apiKey, c.id);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { id: string }).id).toBe(c.id);
    });

    it('answers a parallel request of the same tenant with 429 and Retry-After', async () => {
      const a = await execution(ds, true);
      const held = await slowGet(app, a.apiKey, a.id);
      responses.push(held);
      const res = await detail(app, a.apiKey, a.id);
      expect(res.status).toBe(429);
      expect(res.headers.get('retry-after')).toBe('1');
      expect(await res.json()).toMatchObject({ error: 'detail_in_progress' });
      held.destroy();
      await waitFor(
        'the tenant share to return after the client disconnects',
        async () => (await detailStatus(app, a.apiKey, a.id)) === 200,
      );
    });
  });

  describe('with a pool of two snapshots', () => {
    let app: RunningApp;
    beforeAll(async () => {
      app = await startWith({
        DETAIL_MAX_CONCURRENT: '2',
        DETAIL_MAX_PER_TENANT: '1',
      });
    });
    afterAll(() => app.close());

    it('answers 503 with Retry-After while the pool is full and serves the request after a release', async () => {
      const a = await execution(ds, true);
      const b = await execution(ds, true);
      const c = await execution(ds, false);
      const held = [
        await slowGet(app, a.apiKey, a.id),
        await slowGet(app, b.apiKey, b.id),
      ];
      responses.push(...held);
      const res = await detail(app, c.apiKey, c.id);
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('1');
      held[0].destroy();
      await waitFor(
        'a pool place to return after a slow reader disconnects',
        async () => (await detailStatus(app, c.apiKey, c.id)) === 200,
      );
    });
  });
});
