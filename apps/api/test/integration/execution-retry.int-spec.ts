import { DataSource } from 'typeorm';
import { Execution, Job, StepRun } from '../../src/entities';
import { MetricsService } from '../../src/observability/metrics.service';
import { RunningApp, startApp } from '../helpers/app';
import {
  createExecution,
  createTenant,
  createWorkflow,
  openTestDataSource,
  TestTenant,
  truncateAll,
} from '../helpers/db';
import { api, Receiver, startWorker, waitFor } from '../helpers/queue';

/** JOB_MAX_ATTEMPTS у тестах — 3. */
describe('POST /executions/:id/retry', () => {
  let ds: DataSource;
  let apiApp: RunningApp;
  let worker: RunningApp | undefined;
  const receiver = new Receiver();
  let tenant: TestTenant;
  let receiverUp: boolean;

  beforeAll(async () => {
    ds = await openTestDataSource();
    apiApp = await startApp();
    await receiver.start();
  });

  beforeEach(async () => {
    await truncateAll(ds);
    tenant = await createTenant(ds);
    receiverUp = false;
    // `/charge` працює завжди, `/notify` — лише коли receiverUp.
    receiver.respond = (req, res) => {
      if (req.path === '/notify' && !receiverUp)
        return void res.writeHead(503).end();
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    };
  });

  afterEach(async () => {
    await worker?.close();
    worker = undefined;
    receiver.requests.length = 0;
  });

  afterAll(async () => {
    await apiApp.close();
    await receiver.stop();
    await ds.destroy();
  });

  const call = <T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    key = tenant.apiKey,
  ) => api<T>(apiApp.baseUrl, key, method, path, body);

  const execution = (id: string) =>
    ds.getRepository(Execution).findOneByOrFail({ id });

  const finished = (id: string) =>
    waitFor('the execution to finish', async () =>
      ['succeeded', 'failed'].includes((await execution(id)).status),
    );

  /** Виконання, що вичерпало спроби на другому кроці (задача dead). */
  async function deadExecution(): Promise<string> {
    const wf = await call<{ id: string }>('POST', '/workflows', {
      name: 'retry',
      steps: [
        {
          id: 'charge',
          type: 'http',
          method: 'POST',
          url: receiver.url('/charge'),
        },
        {
          id: 'notify',
          type: 'http',
          method: 'POST',
          url: receiver.url('/notify'),
        },
      ],
    });
    const run = await call<{ id: string }>(
      'POST',
      `/workflows/${wf.body.id}/run`,
      {},
    );
    worker = await startWorker(1);
    await finished(run.body.id);
    expect(
      await ds.getRepository(Job).findOneByOrFail({ executionId: run.body.id }),
    ).toMatchObject({ status: 'dead' });
    return run.body.id;
  }

  it('continues a dead execution from the failed step, keeping the idempotency key', async () => {
    const id = await deadExecution();
    receiverUp = true;

    const res = await call<{ executionId: string }>(
      'POST',
      `/executions/${id}/retry`,
    );
    expect(res).toEqual({ status: 202, body: { executionId: id } });
    await finished(id);

    expect(await execution(id)).toMatchObject({
      status: 'succeeded',
      error: null,
    });
    // Завершений крок не повторено; повторений має той самий ключ, що й попередні спроби.
    expect(receiver.hits('/charge')).toHaveLength(1);
    const keys = receiver
      .hits('/notify')
      .map((r) => r.headers['idempotency-key']);
    expect(keys).toHaveLength(4);
    expect(new Set(keys).size).toBe(1);
    const steps = await ds
      .getRepository(StepRun)
      .find({ where: { executionId: id }, order: { stepIndex: 'ASC' } });
    expect(steps.map((s) => [s.stepId, s.status, s.attempts])).toEqual([
      ['charge', 'succeeded', 1],
      ['notify', 'succeeded', 4],
    ]);
    expect(await apiApp.app.get(MetricsService).render()).toContain(
      'flowforge_executions_retried_total 1',
    );
  });

  it('does not reveal or retry an execution of another tenant (404)', async () => {
    const id = await deadExecution();
    const other = await createTenant(ds, 'other');

    const res = await call(
      'POST',
      `/executions/${id}/retry`,
      undefined,
      other.apiKey,
    );

    expect(res.status).toBe(404);
    expect((await execution(id)).status).toBe('failed');
  });

  it.each(['pending', 'succeeded'] as const)(
    'refuses to retry a %s execution (409)',
    async (status) => {
      const wf = await createWorkflow(ds, tenant.tenant.id);
      const { id } = await createExecution(ds, wf, { status });
      expect((await call('POST', `/executions/${id}/retry`)).status).toBe(409);
    },
  );

  it('refuses to retry a historical execution without a version snapshot (409)', async () => {
    const wf = await createWorkflow(ds, tenant.tenant.id);
    const { id } = await createExecution(ds, wf, {
      status: 'failed',
      workflowVersionId: null,
    });
    expect((await call('POST', `/executions/${id}/retry`)).status).toBe(409);
  });

  it('accepts only one of two simultaneous retries', async () => {
    const id = await deadExecution();
    await worker!.close();
    worker = undefined;

    const results = await Promise.all([
      call('POST', `/executions/${id}/retry`),
      call('POST', `/executions/${id}/retry`),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([202, 409]);
    expect(await ds.getRepository(Job).countBy({ executionId: id })).toBe(1);
  });

  it('creates a new job when the finished one was already deleted by the cleanup', async () => {
    const id = await deadExecution();
    await ds.query(`DELETE FROM jobs WHERE "executionId" = $1`, [id]);
    receiverUp = true;

    expect((await call('POST', `/executions/${id}/retry`)).status).toBe(202);
    await finished(id);

    expect((await execution(id)).status).toBe('succeeded');
    expect(
      await ds.getRepository(Job).findOneByOrFail({ executionId: id }),
    ).toMatchObject({ status: 'done', attempts: 1 });
  });
});
