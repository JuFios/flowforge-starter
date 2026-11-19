import { DataSource } from 'typeorm';
import { Execution, Job } from '../../src/entities';
import { RunningApp, startApp } from '../helpers/app';
import { createTenant, openTestDataSource, truncateAll } from '../helpers/db';

/**
 * Ліміти тенанта (ТЗ 3.3.4): розмір черги й частота запитів. Ліміти задаються перевизначенням у
 * тенанта (адмін-API — tenant-limits-admin.int-spec), тут — напряму в БД.
 */
describe('tenant limits on the API', () => {
  let owner: DataSource;
  let apiApp: RunningApp;

  beforeAll(async () => {
    owner = await openTestDataSource();
    apiApp = await startApp();
  });

  beforeEach(() => truncateAll(owner));

  afterAll(async () => {
    await apiApp.close();
    await truncateAll(owner);
    await owner.destroy();
  });

  async function tenantWith(
    limits: Record<string, number>,
  ): Promise<{ id: string; apiKey: string }> {
    const { tenant, apiKey } = await createTenant(owner);
    for (const [column, value] of Object.entries(limits))
      await owner.query(`UPDATE tenants SET "${column}" = $2 WHERE id = $1`, [
        tenant.id,
        value,
      ]);
    return { id: tenant.id, apiKey };
  }

  function call(
    apiKey: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    return fetch(`${apiApp.baseUrl}${path}`, {
      method,
      headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function workflow(apiKey: string): Promise<string> {
    const res = await call(apiKey, 'POST', '/workflows', {
      name: 'limited',
      steps: [{ id: 'say', type: 'log', message: 'hi' }],
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  it('rejects a run beyond the queue size of the tenant with 429 queue_full and creates nothing', async () => {
    const { id, apiKey } = await tenantWith({ maxQueueSize: 5 });
    const wf = await workflow(apiKey);
    for (let i = 0; i < 5; i++)
      expect(
        (await call(apiKey, 'POST', `/workflows/${wf}/run`, {})).status,
      ).toBe(201);
    const res = await call(apiKey, 'POST', `/workflows/${wf}/run`, {});
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: 'queue_full' });
    // Місце звільниться, коли задачі завершаться, — коли саме, невідомо: без Retry-After.
    expect(res.headers.get('retry-after')).toBeNull();
    expect(await owner.getRepository(Execution).countBy({ tenantId: id })).toBe(
      5,
    );
    expect(await owner.getRepository(Job).countBy({ tenantId: id })).toBe(5);
  });

  it('rejects requests beyond the request rate of the tenant with 429 rate_limited and Retry-After', async () => {
    const { apiKey } = await tenantWith({ rateLimit: 3 });
    for (let i = 0; i < 3; i++)
      expect((await call(apiKey, 'GET', '/workflows')).status).toBe(200);
    const res = await call(apiKey, 'GET', '/workflows');
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: 'rate_limited' });
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});
