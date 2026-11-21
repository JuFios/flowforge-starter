import { DataSource } from 'typeorm';
import {
  limitDefaultsFromEnv,
  provisionLimitDefaults,
} from '../../src/database/provision';
import { RunningApp, startApp } from '../helpers/app';
import { openTestDataSource, truncateAll } from '../helpers/db';
import { TEST_ADMIN_TOKEN } from '../helpers/test-env';
import { provisionTestDatabase } from '../helpers/test-provision';

/**
 * Адмін-API лімітів тенанта: перевизначення під час створення й пізніше (`null` — значення за
 * замовчуванням), межі контракту, ефективні значення; значення за замовчуванням — з db:provision
 * (одне джерело для API і воркера).
 */
describe('tenant limits admin API', () => {
  let owner: DataSource;
  let apiApp: RunningApp;

  beforeAll(async () => {
    owner = await openTestDataSource();
    apiApp = await startApp();
  });

  beforeEach(() => truncateAll(owner));

  afterAll(async () => {
    await apiApp.close();
    await provisionTestDatabase(owner);
    await truncateAll(owner);
    await owner.destroy();
  });

  function admin(
    method: string,
    path: string,
    body?: unknown,
    token = TEST_ADMIN_TOKEN,
  ): Promise<Response> {
    return fetch(`${apiApp.baseUrl}${path}`, {
      method,
      headers: { 'x-admin-token': token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function usage(
    id: string,
  ): Promise<{ maxRunning: number; maxQueueSize: number }> {
    const [row]: Array<{ maxRunning: number; maxQueueSize: number }> =
      await owner.query(
        `SELECT "maxRunning", "maxQueueSize" FROM tenant_usage WHERE "tenantId" = $1`,
        [id],
      );
    return row;
  }

  it('creates a tenant with overrides and reports overrides and effective limits', async () => {
    const res = await admin('POST', '/tenants', {
      name: 'limited',
      limits: { maxConcurrentExecutions: 3, rateLimit: 50 },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; limits: unknown };
    expect(body.limits).toEqual({
      overrides: {
        maxConcurrentExecutions: 3,
        maxQueueSize: null,
        rateLimit: 50,
        webhookRateLimit: null,
        maxWorkflows: null,
        maxOutboxEvents: null,
      },
      effective: {
        maxRunning: 3,
        maxQueueSize: 100_000,
        rateLimit: 50,
        rateWindowMs: 60_000,
        webhookRateLimit: 600,
        webhookRateWindowMs: 60_000,
        maxWorkflows: 1000,
        maxOutboxEvents: 200_000,
      },
    });
    expect(await usage(body.id)).toEqual({
      maxRunning: 3,
      maxQueueSize: 100_000,
    });
    const read = await admin('GET', `/tenants/${body.id}/limits`);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual(body.limits);
  });

  it('rejects an empty array in place of a PATCH limits object', async () => {
    const { id } = (await (
      await admin('POST', '/tenants', { name: 'patch-array' })
    ).json()) as { id: string };
    expect((await admin('PATCH', `/tenants/${id}/limits`, [])).status).toBe(
      400,
    );
  });

  it('rejects reserved unknown keys inside the limits object', async () => {
    expect(
      (
        await admin('POST', '/tenants', {
          name: 'invalid',
          limits: { constructor: 1 },
        })
      ).status,
    ).toBe(400);
  });

  it('rejects an array of limits without creating a tenant', async () => {
    const res = await admin('POST', '/tenants', {
      name: 'invalid',
      limits: [{ maxQueueSize: 1 }],
    });
    expect(res.status).toBe(400);
    expect(await owner.query('SELECT id FROM tenants')).toHaveLength(0);
  });

  it('reads overrides and effective quotas from the same statement snapshot', async () => {
    const { id } = (await (
      await admin('POST', '/tenants', {
        name: 'snapshot',
        limits: { maxQueueSize: 2 },
      })
    ).json()) as { id: string };
    const ds = apiApp.app.get(DataSource);
    let updated = false;
    const observer = {
      afterQuery: async (event: { query: string }) => {
        if (
          !updated &&
          /FROM "tenants"|FROM (?:public\.)?tenants\b/i.test(event.query)
        ) {
          updated = true;
          await owner.query('UPDATE tenants SET "maxQueueSize"=3 WHERE id=$1', [
            id,
          ]);
        }
      },
    };
    ds.subscribers.push(observer);
    try {
      const view = (await (
        await admin('GET', `/tenants/${id}/limits`)
      ).json()) as {
        overrides: { maxQueueSize: number };
        effective: { maxQueueSize: number };
      };
      expect(updated).toBe(true);
      expect(view.overrides.maxQueueSize).toBe(view.effective.maxQueueSize);
    } finally {
      ds.subscribers.splice(ds.subscribers.indexOf(observer), 1);
    }
  });

  it('changes and resets overrides, leaving the omitted ones as they are', async () => {
    const { id } = (await (
      await admin('POST', '/tenants', { name: 'patch' })
    ).json()) as { id: string };
    let res = await admin('PATCH', `/tenants/${id}/limits`, {
      maxQueueSize: 7,
      webhookRateLimit: 5,
    });
    expect(res.status).toBe(200);
    expect(await usage(id)).toMatchObject({ maxQueueSize: 7 });
    res = await admin('PATCH', `/tenants/${id}/limits`, { maxQueueSize: null });
    expect(
      ((await res.json()) as { overrides: Record<string, unknown> }).overrides,
    ).toEqual({
      maxConcurrentExecutions: null,
      maxQueueSize: null,
      rateLimit: null,
      webhookRateLimit: 5,
      maxWorkflows: null,
      maxOutboxEvents: null,
    });
    expect(await usage(id)).toMatchObject({ maxQueueSize: 100_000 });
  });

  it.each([
    { maxConcurrentExecutions: 0 },
    { maxConcurrentExecutions: 1001 },
    { maxQueueSize: 10_000_001 },
    { rateLimit: 1.5 },
    { webhookRateLimit: '10' },
    { unknownLimit: 1 },
  ])('rejects %p with 400', async (limits) => {
    const { id } = (await (
      await admin('POST', '/tenants', { name: 'bounds' })
    ).json()) as { id: string };
    expect((await admin('PATCH', `/tenants/${id}/limits`, limits)).status).toBe(
      400,
    );
    expect(
      (await admin('POST', '/tenants', { name: 'bounds', limits })).status,
    ).toBe(400);
  });

  it('requires the admin token and answers 404 for an unknown tenant', async () => {
    const { id } = (await (
      await admin('POST', '/tenants', { name: 'auth' })
    ).json()) as { id: string };
    expect(
      (await admin('GET', `/tenants/${id}/limits`, undefined, 'wrong-token-00'))
        .status,
    ).toBe(403);
    expect(
      (
        await admin(
          'PATCH',
          `/tenants/${id}/limits`,
          { rateLimit: 1 },
          'wrong-token-00',
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await admin(
          'GET',
          `/tenants/00000000-0000-4000-8000-000000000000/limits`,
        )
      ).status,
    ).toBe(404);
    expect((await admin('GET', `/tenants/not-a-uuid/limits`)).status).toBe(400);
  });

  it('serializes new tenants with an in-flight change to defaults', async () => {
    const writer = owner.createQueryRunner();
    const creator = owner.createQueryRunner();
    await writer.connect();
    await creator.connect();
    try {
      await writer.startTransaction();
      await writer.query('UPDATE limit_defaults SET "maxRunning"=1');
      const [{ pid }]: Array<{ pid: number }> = (await creator.query(
        'select pg_backend_pid() as pid',
      )) as Array<{ pid: number }>;
      let done = false;
      const inserted: Promise<void> = creator
        .query(
          `INSERT INTO tenants(name,"apiKeyHash","webhookSecret") VALUES ('race','race','race')`,
        )
        .then(() => {
          done = true;
        });
      try {
        for (let i = 0; !done && i < 100; i++) {
          const [{ blocked }]: Array<{ blocked: boolean }> = await owner.query(
            'SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',
            [pid],
          );
          if (blocked) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } finally {
        await writer.commitTransaction();
        await inserted;
      }
      expect(
        await owner.query('SELECT "maxRunning" FROM tenant_usage'),
      ).toEqual([{ maxRunning: 1 }]);
    } finally {
      if (writer.isTransactionActive) await writer.rollbackTransaction();
      await writer.release();
      await creator.release();
      await provisionTestDatabase(owner);
    }
  });

  it('applies new defaults from db:provision to every tenant without its own override', async () => {
    const plain = (await (
      await admin('POST', '/tenants', { name: 'plain' })
    ).json()) as { id: string };
    const own = (await (
      await admin('POST', '/tenants', {
        name: 'own',
        limits: { maxConcurrentExecutions: 2 },
      })
    ).json()) as { id: string };
    await provisionLimitDefaults(
      (sql, params) => owner.query(sql, params),
      limitDefaultsFromEnv({
        TENANT_MAX_RUNNING: '25',
        TENANT_MAX_QUEUE_SIZE: '500',
      }),
    );
    expect(await usage(plain.id)).toEqual({
      maxRunning: 25,
      maxQueueSize: 500,
    });
    expect(await usage(own.id)).toEqual({ maxRunning: 2, maxQueueSize: 500 });
    const effective = (await (
      await admin('GET', `/tenants/${plain.id}/limits`)
    ).json()) as { effective: Record<string, number> };
    expect(effective.effective).toMatchObject({
      maxRunning: 25,
      maxQueueSize: 500,
    });
  });
});
