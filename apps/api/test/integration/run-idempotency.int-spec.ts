import { DataSource } from 'typeorm';
import { Execution, Job } from '../../src/entities';
import { RunningApp, startApp } from '../helpers/app';
import { api } from '../helpers/queue';
import { waitForBlocked } from '../helpers/transaction-barrier';
import { waitFor } from '../helpers/wait-for';
import {
  createTenant,
  createWorkflow,
  openTestDataSource,
  TestTenant,
  truncateAll,
} from '../helpers/db';

/**
 * Клієнт, що не отримав відповіді на запуск (обрив, таймаут), повторює запит. З тим самим
 * `Idempotency-Key` повтор не створює другого виконання.
 */
describe('POST /workflows/:id/run with an Idempotency-Key', () => {
  let ds: DataSource;
  let running: RunningApp;
  let tenant: TestTenant;
  let workflowId: string;

  beforeAll(async () => {
    ds = await openTestDataSource();
    running = await startApp();
  });

  beforeEach(async () => {
    await truncateAll(ds);
    tenant = await createTenant(ds);
    workflowId = (await createWorkflow(ds, tenant.tenant.id)).id;
  });

  afterAll(async () => {
    await running.close();
    await ds.destroy();
  });

  async function run(
    input: unknown,
    key?: string,
    { apiKey = tenant.apiKey, workflow = workflowId } = {},
  ): Promise<{ status: number; body: { id?: string; message?: string } }> {
    const res = await fetch(`${running.baseUrl}/workflows/${workflow}/run`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'content-type': 'application/json',
        ...(key !== undefined && { 'idempotency-key': key }),
      },
      body: JSON.stringify(input),
    });
    return {
      status: res.status,
      body: (await res.json()) as { id?: string; message?: string },
    };
  }

  const count = async () => ({
    executions: await ds.getRepository(Execution).count(),
    jobs: await ds.getRepository(Job).count(),
  });

  it('replays an accepted request after workflow deletion', async () => {
    const first = await run({ n: 1 }, 'accepted');
    expect(first.status).toBe(201);
    const deletion = await fetch(`${running.baseUrl}/workflows/${workflowId}`, {
      method: 'DELETE',
      headers: { 'x-api-key': tenant.apiKey },
    });
    expect(deletion.ok).toBe(true);
    expect(await run({ n: 1 }, 'accepted')).toMatchObject({
      status: 200,
      body: { id: first.body.id },
    });
    expect((await run({ n: 2 }, 'accepted')).status).toBe(422);
    expect((await run({ n: 1 }, 'fresh')).status).toBe(404);
    expect((await run({ n: 1 })).status).toBe(404);
    const foreign = await createTenant(ds, 'foreign');
    expect(
      (await run({ n: 1 }, 'accepted', { apiKey: foreign.apiKey })).status,
    ).toBe(404);
    expect(await count()).toEqual({ executions: 1, jobs: 1 });
  });

  it('creates one execution for a repeated request with the same key', async () => {
    const first = await run({ order: 1 }, 'order-1');
    const again = await run({ order: 1 }, 'order-1');

    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    expect(await count()).toEqual({ executions: 1, jobs: 1 });
  });

  it('creates one execution when the same request races itself', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => run({ order: 2 }, 'order-2')),
    );

    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await count()).toEqual({ executions: 1, jobs: 1 });
  });

  it('rejects the same key with a different input or workflow (422)', async () => {
    await run({ order: 3 }, 'order-3');
    const other = await createWorkflow(ds, tenant.tenant.id, 'other');

    expect((await run({ order: 4 }, 'order-3')).status).toBe(422);
    expect(
      (await run({ order: 3 }, 'order-3', { workflow: other.id })).status,
    ).toBe(422);
    expect(await count()).toEqual({ executions: 1, jobs: 1 });
  });

  it('treats the same key of another tenant as a different request', async () => {
    const b = await createTenant(ds, 'b');
    const wfB = await createWorkflow(ds, b.tenant.id);
    await run({ order: 5 }, 'shared-key');
    const other = await run({ order: 5 }, 'shared-key', {
      apiKey: b.apiKey,
      workflow: wfB.id,
    });

    expect(other.status).toBe(201);
    expect(await count()).toEqual({ executions: 2, jobs: 2 });
  });

  it('keeps creating a new execution per request without a key', async () => {
    await run({ order: 6 });
    await run({ order: 6 });
    expect(await count()).toEqual({ executions: 2, jobs: 2 });
  });

  it.each(['PATCH', 'DELETE'] as const)(
    'serializes unkeyed runs with a concurrent %s of the workflow',
    async (method) => {
      const holder = ds.createQueryRunner();
      await holder.connect();
      await holder.startTransaction();
      const pending: Promise<unknown>[] = [];
      try {
        const [{ pid }] = (await holder.query(
          'SELECT pg_backend_pid() AS pid',
        )) as Array<{ pid: number }>;
        await holder.query(
          'SELECT "tenantId" FROM tenant_usage WHERE "tenantId"=$1 FOR UPDATE',
          [tenant.tenant.id],
        );
        const launching = run({});
        pending.push(Promise.allSettled([launching]));
        await waitForBlocked(ds, holder);
        const [{ pid: launcher }] = await ds.query<Array<{ pid: number }>>(
          'SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
          [pid],
        );
        let changed = false;
        const changing = api(
          running.baseUrl,
          tenant.apiKey,
          method,
          '/workflows/' + workflowId,
          method === 'PATCH'
            ? { steps: [{ id: 'say', type: 'log', message: 'new definition' }] }
            : undefined,
        ).finally(() => {
          changed = true;
        });
        pending.push(Promise.allSettled([changing]));
        await waitFor('workflow edit to reach the lock', async () => {
          const [{ blocked }] = await ds.query<Array<{ blocked: boolean }>>(
            'SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS blocked',
            [launcher],
          );
          return changed || blocked;
        });
        expect(changed).toBe(false);
        expect(await count()).toEqual({ executions: 0, jobs: 0 });

        await holder.commitTransaction();
        const launched = await launching;
        expect(launched.status).toBe(201);
        expect((await changing).status).toBe(method === 'PATCH' ? 200 : 204);
        const [{ version }] = await ds.query<Array<{ version: number }>>(
          'SELECT v.version FROM executions e JOIN workflow_versions v ON v.id=e."workflowVersionId" WHERE e.id=$1',
          [launched.body.id],
        );
        expect(version).toBe(1);
        if (method === 'PATCH') {
          const next = await run({});
          expect(next.status).toBe(201);
          const [{ version: nextVersion }] = await ds.query<
            Array<{ version: number }>
          >(
            'SELECT v.version FROM executions e JOIN workflow_versions v ON v.id=e."workflowVersionId" WHERE e.id=$1',
            [next.body.id],
          );
          expect(nextVersion).toBe(2);
        } else {
          expect((await run({})).status).toBe(404);
        }
      } finally {
        if (holder.isTransactionActive) await holder.rollbackTransaction();
        await holder.release();
        await Promise.all(pending);
      }
    },
  );

  it.each([
    ['empty', ''],
    ['too long', 'k'.repeat(256)],
    ['containing a space', 'order 7'],
  ])('rejects a key that is %s (400)', async (_case, key) => {
    expect((await run({ order: 7 }, key)).status).toBe(400);
    expect(await count()).toEqual({ executions: 0, jobs: 0 });
  });
});
