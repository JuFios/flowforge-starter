import { DataSource } from 'typeorm';
import { Workflow } from '../../src/entities';
import { RunningApp, startApp } from '../helpers/app';
import { createTenant, openTestDataSource, truncateAll } from '../helpers/db';
import { waitForBlocked } from '../helpers/transaction-barrier';
import { TEST_ADMIN_TOKEN } from '../helpers/test-env';
import { newCredentials } from '../helpers/credentials';

/**
 * Квота тенанта на кількість workflow (беклог PR 6, P1): без неї тенант у межах rate limit
 * створює десятки тисяч визначень. Перевірка й вставка — в одній транзакції під блокуванням, тож
 * паралельні створення не перевищують квоти.
 */
describe('workflow quota of a tenant', () => {
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

  function admin(method: string, path: string, body?: unknown) {
    return fetch(`${apiApp.baseUrl}${path}`, {
      method,
      headers: {
        'x-admin-token': TEST_ADMIN_TOKEN,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  function create(apiKey: string, name = 'wf'): Promise<Response> {
    return fetch(`${apiApp.baseUrl}/workflows`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        steps: [{ id: 'say', type: 'log', message: 'hi' }],
      }),
    });
  }

  async function tenantWithQuota(
    maxWorkflows: number,
  ): Promise<{ id: string; apiKey: string }> {
    const { tenant, apiKey } = await createTenant(owner);
    const res = await admin('PATCH', `/tenants/${tenant.id}/limits`, {
      maxWorkflows,
    });
    expect(res.status).toBe(200);
    return { id: tenant.id, apiKey };
  }

  const count = (tenantId: string) =>
    owner.getRepository(Workflow).countBy({ tenantId });

  it('rejects the workflow beyond the quota with 429 workflow_limit_reached and no Retry-After', async () => {
    const { id, apiKey } = await tenantWithQuota(2);
    expect((await create(apiKey)).status).toBe(201);
    expect((await create(apiKey)).status).toBe(201);
    const res = await create(apiKey);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({
      statusCode: 429,
      error: 'workflow_limit_reached',
    });
    // Місце звільняє лише видалення — момент невідомий, тож без Retry-After, як queue_full.
    expect(res.headers.get('retry-after')).toBeNull();
    expect(res.headers.get('x-ratelimit-limit')).not.toBeNull();
    expect(await count(id)).toBe(2);
  });

  it('frees a slot when a workflow is deleted', async () => {
    const { apiKey } = await tenantWithQuota(1);
    const first = (await (await create(apiKey)).json()) as { id: string };
    expect((await create(apiKey)).status).toBe(429);
    const del = await fetch(`${apiApp.baseUrl}/workflows/${first.id}`, {
      method: 'DELETE',
      headers: { 'x-api-key': apiKey },
    });
    expect(del.status).toBe(204);
    expect((await create(apiKey)).status).toBe(201);
  });

  it('serialises the last free slot: a concurrent create waits for the open insert and is rejected', async () => {
    const { id, apiKey } = await tenantWithQuota(2);
    expect((await create(apiKey)).status).toBe(201);
    // Відкрита транзакція займає останнє місце (той самий тригер, що й для API).
    const holder = owner.createQueryRunner();
    await holder.connect();
    await holder.startTransaction();
    try {
      await holder.query(
        `INSERT INTO workflows ("tenantId", name, steps) VALUES ($1, 'held', '[]')`,
        [id],
      );
      const pending = create(apiKey, 'racing');
      await waitForBlocked(owner, holder);
      await holder.commitTransaction();
      const res = await pending;
      expect(res.status).toBe(429);
      expect(await res.json()).toMatchObject({
        error: 'workflow_limit_reached',
      });
    } finally {
      if (holder.isTransactionActive) await holder.rollbackTransaction();
      await holder.release();
    }
    expect(await count(id)).toBe(2);
  });

  it('accepts exactly the free slots out of many parallel creates', async () => {
    const { id, apiKey } = await tenantWithQuota(5);
    const statuses = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        create(apiKey, `p${i}`).then((r) => r.status),
      ),
    );
    expect(statuses.filter((s) => s === 201)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(15);
    expect(await count(id)).toBe(5);
  });

  it('counts the quota per tenant', async () => {
    const a = await tenantWithQuota(1);
    const b = await tenantWithQuota(1);
    expect((await create(a.apiKey)).status).toBe(201);
    expect((await create(b.apiKey)).status).toBe(201);
    expect((await create(a.apiKey)).status).toBe(429);
  });

  it('enforces the quota in the database for any insert path', async () => {
    const { id } = await tenantWithQuota(1);
    await owner.query(
      `INSERT INTO workflows ("tenantId", name, steps) VALUES ($1, 'a', '[]')`,
      [id],
    );
    await expect(
      owner.query(
        `INSERT INTO workflows ("tenantId", name, steps) VALUES ($1, 'b', '[]')`,
        [id],
      ),
    ).rejects.toMatchObject({ driverError: { code: 'FF001' } });
  });

  it('keeps workflows of a tenant above a lowered quota readable, editable and deletable', async () => {
    const { tenant, apiKey } = await createTenant(owner);
    for (let i = 0; i < 3; i++) expect((await create(apiKey)).status).toBe(201);
    const lowered = await admin('PATCH', `/tenants/${tenant.id}/limits`, {
      maxWorkflows: 1,
    });
    expect(lowered.status).toBe(200);
    const list = await fetch(`${apiApp.baseUrl}/workflows`, {
      headers: { 'x-api-key': apiKey },
    });
    const page = (await list.json()) as { items: Array<{ id: string }> };
    expect(page.items).toHaveLength(3);
    const patched = await fetch(
      `${apiApp.baseUrl}/workflows/${page.items[0].id}`,
      {
        method: 'PATCH',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'renamed',
          steps: [{ id: 'say', type: 'log', message: 'v2' }],
        }),
      },
    );
    expect(patched.status).toBe(200);
    expect((await create(apiKey)).status).toBe(429);
    const del = await fetch(`${apiApp.baseUrl}/workflows/${page.items[1].id}`, {
      method: 'DELETE',
      headers: { 'x-api-key': apiKey },
    });
    expect(del.status).toBe(204);
  });

  it('exposes the quota in the limits view, resets it to the default and validates the bounds', async () => {
    const { tenant } = await createTenant(owner);
    const view = (await (
      await admin('GET', `/tenants/${tenant.id}/limits`)
    ).json()) as {
      overrides: { maxWorkflows: number | null };
      effective: { maxWorkflows: number };
    };
    expect(view.overrides.maxWorkflows).toBeNull();
    expect(view.effective.maxWorkflows).toBe(1000);

    const set = (await (
      await admin('PATCH', `/tenants/${tenant.id}/limits`, {
        maxWorkflows: 7,
      })
    ).json()) as typeof view;
    expect(set.overrides.maxWorkflows).toBe(7);
    expect(set.effective.maxWorkflows).toBe(7);

    const reset = (await (
      await admin('PATCH', `/tenants/${tenant.id}/limits`, {
        maxWorkflows: null,
      })
    ).json()) as typeof view;
    expect(reset.overrides.maxWorkflows).toBeNull();
    expect(reset.effective.maxWorkflows).toBe(1000);

    for (const bad of [0, 100_001, 1.5, 'many'])
      expect(
        (
          await admin('PATCH', `/tenants/${tenant.id}/limits`, {
            maxWorkflows: bad,
          })
        ).status,
      ).toBe(400);
    await expect(
      owner.query(`UPDATE tenants SET "maxWorkflows" = 0 WHERE id = $1`, [
        tenant.id,
      ]),
    ).rejects.toMatchObject({ driverError: { code: '23514' } });
  });

  it('accepts the quota when the tenant is created', async () => {
    const res = await admin('POST', '/tenants', {
      ...newCredentials(),
      name: 'quota',
      limits: { maxWorkflows: 3 },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      limits: {
        overrides: { maxWorkflows: 3 },
        effective: { maxWorkflows: 3 },
      },
    });
  });
});
