import { finished } from 'node:stream/promises';
import {
  DataSource,
  EntityManager,
  EntityTarget,
  FindOptionsWhere,
  ObjectLiteral,
} from 'typeorm';
import { WorkerModule } from '../../src/app.module';
import { MAX_RESPONSE_BYTES } from '../../src/config/outbound';
import { Execution, StepRun } from '../../src/entities';
import { ExecutionReader } from '../../src/executions/execution-reader.service';
import { SystemDb } from '../../src/tenancy/system-db';
import { TenantDb } from '../../src/tenancy/tenant-db';
import { MAX_STEPS } from '../../src/workflows/definition';
import { RunningApp, startApp } from '../helpers/app';
import {
  createExecution,
  createTenant,
  createWorkflow,
  openTestDataSource,
  truncateAll,
} from '../helpers/db';
import { startWorker, waitFor } from '../helpers/queue';
import { stopSchedulerTimer, tenantCall } from '../helpers/schedule';

describe('execution details use one PostgreSQL snapshot', () => {
  let ds: DataSource;
  let api: RunningApp;
  let maintenance: RunningApp;
  let worker: RunningApp | undefined;

  beforeAll(async () => {
    ds = await openTestDataSource();
    api = await startApp();
    stopSchedulerTimer(api);
    maintenance = await startApp(WorkerModule);
  });

  beforeEach(async () => truncateAll(ds));
  afterEach(async () => {
    jest.restoreAllMocks();
    await worker?.close();
    worker = undefined;
  });
  afterAll(async () => {
    await maintenance.close();
    await api.close();
    await truncateAll(ds);
    await ds.destroy();
  });

  function afterReadingExecution(
    callback: (em: EntityManager) => Promise<void>,
  ) {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Оригінал викликається з тим самим EntityManager через call.
    const original = EntityManager.prototype.findOneBy;
    let ran = false;
    jest
      .spyOn(EntityManager.prototype, 'findOneBy')
      .mockImplementation(async function <Entity extends ObjectLiteral>(
        this: EntityManager,
        entity: EntityTarget<Entity>,
        where: FindOptionsWhere<Entity> | FindOptionsWhere<Entity>[],
      ): Promise<Entity | null> {
        const row = (await original.call(this, entity, where)) as Entity | null;
        if (entity === Execution && !ran) {
          ran = true;
          await callback(this);
        }
        return row;
      });
  }

  it('keeps pending execution and steps from before a worker commits completion between reads', async () => {
    const { tenant, apiKey } = await createTenant(ds);
    const wf = await createWorkflow(ds, tenant.id);
    const run = await tenantCall(
      api,
      apiKey,
      'POST',
      `/workflows/${wf.id}/run`,
      {},
    );
    expect(run.status).toBe(201);
    const { id } = (await run.json()) as Execution;
    afterReadingExecution(async () => {
      worker = await startWorker(1);
      await waitFor(
        'worker completion',
        async () =>
          (await ds.getRepository(Execution).findOneByOrFail({ id })).status ===
          'succeeded',
      );
    });
    const response = await tenantCall(api, apiKey, 'GET', `/executions/${id}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id,
      status: 'pending',
      steps: [],
    });
    const fresh = await tenantCall(api, apiKey, 'GET', `/executions/${id}`);
    expect(await fresh.json()).toMatchObject({
      status: 'succeeded',
      steps: [{ stepIndex: 0, status: 'succeeded' }],
    });
  });

  it('returns all steps when retention commits between reads, then returns 404', async () => {
    const { tenant, apiKey } = await createTenant(ds);
    const wf = await createWorkflow(ds, tenant.id);
    const e = await createExecution(ds, wf, {
      status: 'succeeded',
      finishedAt: new Date('2024-01-01T00:00:00Z'),
    });
    await ds.getRepository(StepRun).insert(
      [0, 1, 2].map((stepIndex) => ({
        executionId: e.id,
        tenantId: tenant.id,
        stepId: `step-${stepIndex}`,
        stepIndex,
        status: 'succeeded' as const,
        output: { stepIndex },
      })),
    );
    afterReadingExecution(async () => {
      expect(
        await maintenance.app.get(SystemDb).purgeExecutionHistory(1, 10),
      ).toBe(1);
    });
    const response = await tenantCall(
      api,
      apiKey,
      'GET',
      `/executions/${e.id}`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: e.id,
      status: 'succeeded',
      steps: [0, 1, 2].map((stepIndex) => ({
        stepIndex,
        output: { stepIndex },
      })),
    });
    const fresh = await tenantCall(api, apiKey, 'GET', `/executions/${e.id}`);
    expect(fresh.status).toBe(404);
    await fresh.text();
  });

  it('returns the snapshot connection before the consumer reads the stream and releases the slot on abort', async () => {
    const { tenant } = await createTenant(ds);
    const wf = await createWorkflow(ds, tenant.id);
    const e = await createExecution(ds, wf);
    const db = api.app.get(TenantDb);
    const original = db.snapshot.bind(db);
    let pid: number | undefined;
    jest.spyOn(db, 'snapshot').mockImplementationOnce((tenantId, read) =>
      original(tenantId, async (em) => {
        const [session]: [{ pid: number }] = await em.query(
          'SELECT pg_backend_pid() AS pid',
        );
        pid = session.pid;
        return read(em);
      }),
    );
    const reader = api.app.get(ExecutionReader);
    const client = new AbortController();
    const detail = await reader.detail(tenant.id, e.id, client.signal);
    const done = finished(detail.getStream());
    try {
      expect(pid).toBeDefined();
      expect(
        await ds.query('SELECT state FROM pg_stat_activity WHERE pid=$1', [
          pid,
        ]),
      ).toEqual([{ state: 'idle' }]);
      await expect(reader.detail(tenant.id, e.id)).rejects.toMatchObject({
        status: 429,
      });
    } finally {
      client.abort();
      await expect(done).rejects.toMatchObject({ code: 'ABORT_ERR' });
    }
    const retry = (await reader.detail(tenant.id, e.id)).getStream();
    const completed = finished(retry);
    retry.resume();
    await completed;
  });

  it('caps an active PostgreSQL read by the remaining detail deadline and releases the slot', async () => {
    const { tenant } = await createTenant(ds);
    const wf = await createWorkflow(ds, tenant.id);
    const e = await createExecution(ds, wf);
    const reader = api.app.get(ExecutionReader);
    const now = performance.now();
    const clock = jest
      .spyOn(performance, 'now')
      .mockReturnValueOnce(now - 59_500);
    let reading = () => {};
    const readingStarted = new Promise<void>((resolve) => {
      reading = resolve;
    });
    afterReadingExecution(async (em) => {
      const slow = em.query('SELECT pg_sleep(3)');
      reading();
      await slow;
    });
    const client = new AbortController();
    const result = reader.detail(tenant.id, e.id, client.signal);
    const rejected = expect(result).rejects.toMatchObject({ status: 503 });
    await readingStarted;
    client.abort();
    await rejected;
    expect(performance.now() - now).toBeLessThan(2_000);
    clock.mockRestore();
    const retry = (await reader.detail(tenant.id, e.id)).getStream();
    const completed = finished(retry);
    retry.resume();
    await completed;
  });

  it('streams every step at the workflow size limit with large HTTP step outputs', async () => {
    const { tenant, apiKey } = await createTenant(ds);
    const wf = await createWorkflow(ds, tenant.id);
    const e = await createExecution(ds, wf);
    await ds.query(
      `INSERT INTO step_runs ("executionId","tenantId","stepIndex","stepId",status,output)
       SELECT $1, $2, i, 'http-' || i, 'succeeded',
              jsonb_build_object('status', 200, 'body', repeat('a', $4))
       FROM generate_series(0, $3::integer - 1) AS i`,
      [e.id, tenant.id, MAX_STEPS, MAX_RESPONSE_BYTES],
    );
    const response = await tenantCall(
      api,
      apiKey,
      'GET',
      `/executions/${e.id}`,
    );
    expect(response.status).toBe(200);
    const body = response.body;
    if (!body) throw new Error('missing execution detail body');
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let last = '';
    let steps = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        last += decoder.decode(chunk.value, { stream: true });
        for (;;) {
          const start = last.indexOf('"stepIndex":');
          if (start === -1) break;
          const match = /^"stepIndex":(\d+),/.exec(
            last.slice(start, start + 20),
          );
          if (!match) break;
          expect(Number(match[1])).toBe(steps);
          steps++;
          last = last.slice(start + match[0].length);
        }
        last = last.slice(-20);
      }
    } finally {
      await reader.cancel();
    }
    expect(steps).toBe(MAX_STEPS);
    expect(bytes).toBe(Number(response.headers.get('content-length')));
    expect(bytes).toBeGreaterThanOrEqual(MAX_STEPS * MAX_RESPONSE_BYTES);
    expect(last.endsWith(']}')).toBe(true);
  });
});
