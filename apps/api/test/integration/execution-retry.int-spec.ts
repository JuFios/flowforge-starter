import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
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
import { waitForBlocked } from '../helpers/transaction-barrier';

/** JOB_MAX_ATTEMPTS у тестах — 3. */
describe('POST /executions/:id/retry', () => {
  let ds: DataSource;
  let apiApp: RunningApp;
  let secondApi: RunningApp;
  let worker: RunningApp | undefined;
  const receiver = new Receiver();
  let tenant: TestTenant;
  let receiverUp: boolean;

  beforeAll(async () => {
    ds = await openTestDataSource();
    apiApp = await startApp();
    secondApi = await startApp();
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
    await secondApi.close();
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

    // Перша транзакція тримає зміну виконання 300 мс: друга встигає прочитати його, поки перша
    // не закомітила, — тож гонка справжня, а не «послідовна».
    await ds.query(`
      CREATE OR REPLACE FUNCTION test_slow_retry() RETURNS trigger AS $$
      BEGIN PERFORM pg_sleep(0.3); RETURN NEW; END $$ LANGUAGE plpgsql;
      REVOKE ALL ON FUNCTION test_slow_retry() FROM PUBLIC;
      CREATE TRIGGER test_slow_retry BEFORE UPDATE ON executions
        FOR EACH ROW WHEN (OLD.status = 'failed') EXECUTE FUNCTION test_slow_retry();`);
    let results: Array<{ status: number }>;
    try {
      results = await Promise.all([
        call('POST', `/executions/${id}/retry`),
        call('POST', `/executions/${id}/retry`),
      ]);
    } finally {
      await ds.query(`
        DROP TRIGGER IF EXISTS test_slow_retry ON executions;
        DROP FUNCTION IF EXISTS test_slow_retry();`);
    }

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

  it('opens only one cycle when two API instances contend for the same failed cycle', async () => {
    const id = await deadExecution();
    await worker!.close();
    worker = undefined;
    const path = `/executions/${id}/retry?expectedTerminalCycle=1`;
    const holder = ds.createQueryRunner();
    await holder.connect();
    await holder.startTransaction();
    await holder.query('SELECT id FROM executions WHERE id=$1 FOR UPDATE', [
      id,
    ]);
    const requests = Promise.all([
      call('POST', path),
      api(secondApi.baseUrl, tenant.apiKey, 'POST', path),
    ]);
    try {
      await waitForBlocked(ds, holder);
      // Другий запит може чекати на першого в черзі блокувань того самого рядка.
      await waitFor(
        'both API transactions to wait for the execution row',
        async () => {
          const [{ waiting }] = await ds.query<Array<{ waiting: number }>>(
            `SELECT count(*)::int AS waiting FROM pg_stat_activity
           WHERE datname=current_database() AND wait_event_type='Lock'
             AND query LIKE '%FROM executions%' AND query LIKE '%FOR UPDATE%'`,
          );
          return waiting === 2;
        },
      );
    } finally {
      await holder.rollbackTransaction();
      await holder.release();
      await requests;
    }
    expect((await requests).map((r) => r.status).sort()).toEqual([202, 409]);
    expect(
      await ds.getRepository(Job).findBy({ executionId: id }),
    ).toMatchObject([{ status: 'queued', attempts: 0 }]);
  });

  it('rejects the original retry after its committed cycle fails again', async () => {
    expect(
      (
        await call('PUT', '/tenants/me/notifications', {
          url: receiver.url('/events'),
        })
      ).status,
    ).toBe(200);
    const id = await deadExecution();
    const path = `/executions/${id}/retry`;
    const cycles = () =>
      ds.query<Array<{ sequence: number }>>(
        'SELECT sequence FROM outbox_events WHERE "executionId"=$1 ORDER BY sequence',
        [id],
      );
    expect(await cycles()).toEqual([{ sequence: 1 }]);
    const upstreamPath = path + '?expectedTerminalCycle=1';
    const transport = createServer((_req, res) => {
      void call('POST', upstreamPath).then(
        (result) => {
          // API вже підтвердив COMMIT. Клієнт втрачає з'єднання до отримання статусу.
          if (result.status === 202) res.destroy();
          else res.writeHead(result.status).end();
        },
        () => res.writeHead(502).end(),
      );
    });
    await new Promise<void>((resolve) =>
      transport.listen(0, '127.0.0.1', resolve),
    );
    try {
      const { port } = transport.address() as AddressInfo;
      await expect(
        fetch(`http://127.0.0.1:${port}/retry`, {
          method: 'POST',
          signal: AbortSignal.timeout(5000),
        }),
      ).rejects.toMatchObject({
        cause: { code: 'UND_ERR_SOCKET' },
      });
    } finally {
      transport.closeAllConnections();
      await new Promise<void>((resolve) => transport.close(() => resolve()));
    }
    await waitFor(
      'the committed retry to fail again',
      async () => (await cycles()).length === 2,
    );
    const job = await ds
      .getRepository(Job)
      .findOneByOrFail({ executionId: id });
    expect(job).toMatchObject({ status: 'dead', attempts: 3 });
    const replay = await api(
      secondApi.baseUrl,
      tenant.apiKey,
      'POST',
      upstreamPath,
    );
    expect(replay.status).toBe(409);
    expect(await execution(id)).toMatchObject({ status: 'failed' });
    expect(await ds.getRepository(Job).findBy({ executionId: id })).toEqual([
      job,
    ]);
    expect(await cycles()).toEqual([{ sequence: 1 }, { sequence: 2 }]);
    expect(receiver.hits('/notify')).toHaveLength(6);

    receiverUp = true;
    const explicit = await call('POST', path + '?expectedTerminalCycle=2');
    expect(explicit).toEqual({ status: 202, body: { executionId: id } });
    await finished(id);
    expect(await cycles()).toEqual([
      { sequence: 1 },
      { sequence: 2 },
      { sequence: 3 },
    ]);
    expect(receiver.hits('/charge')).toHaveLength(1);
    const keys = receiver
      .hits('/notify')
      .map((r) => r.headers['idempotency-key']);
    expect(keys).toHaveLength(7);
    expect(keys[0]).toEqual(expect.any(String));
    expect(new Set(keys).size).toBe(1);
    expect(
      await ds.getRepository(StepRun).findOneByOrFail({
        executionId: id,
        stepIndex: 0,
      }),
    ).toMatchObject({ status: 'succeeded', attempts: 1 });
  });

  it('lets a legacy request without a cycle retry the current failed state again', async () => {
    const id = await deadExecution();
    const path = `/executions/${id}/retry`;
    expect((await call('POST', path)).status).toBe(202);
    await finished(id);
    expect(await execution(id)).toMatchObject({ status: 'failed' });
    expect(receiver.hits('/notify')).toHaveLength(6);
    receiverUp = true;
    expect(await call('POST', path)).toEqual({
      status: 202,
      body: { executionId: id },
    });
    await finished(id);
    expect(await execution(id)).toMatchObject({ status: 'succeeded' });
  });

  it('validates the optional cycle and applies tenant isolation', async () => {
    const wf = await createWorkflow(ds, tenant.tenant.id);
    const { id } = await createExecution(ds, wf, { status: 'failed' });
    const path = `/executions/${id}/retry?expectedTerminalCycle=`;
    for (const invalid of [
      '',
      '1.1',
      '-1',
      '1e0',
      '2147483648',
      '1&expectedTerminalCycle=1',
    ]) {
      expect((await call('POST', path + invalid)).status).toBe(400);
    }
    const other = await createTenant(ds, 'other');
    expect(
      (await call('POST', path + '0', undefined, other.apiKey)).status,
    ).toBe(404);
    const conflict = await call('POST', path + '1');
    expect(conflict).toMatchObject({
      status: 409,
      body: { error: 'retry_cycle_conflict' },
    });
    expect(await ds.getRepository(Job).countBy({ executionId: id })).toBe(0);
  });

  it('preserves the failed cycle when the job update rolls back', async () => {
    const id = await deadExecution();
    await worker!.close();
    worker = undefined;
    const failed = await execution(id);
    const jobs = ds.getRepository(Job);
    const before = await jobs.findOneByOrFail({ executionId: id });
    const path = `/executions/${id}/retry?expectedTerminalCycle=1`;
    await ds.query(`
      CREATE FUNCTION test_reject_retry_job() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'simulated failure while requeuing'; END $$;
      REVOKE ALL ON FUNCTION test_reject_retry_job() FROM PUBLIC;
      CREATE TRIGGER test_reject_retry_job BEFORE UPDATE ON jobs
        FOR EACH ROW WHEN (OLD.status = 'dead' AND NEW.status = 'queued')
        EXECUTE FUNCTION test_reject_retry_job();`);
    try {
      expect((await call('POST', path)).status).toBe(500);
      expect(await execution(id)).toEqual(failed);
      expect(await jobs.findBy({ executionId: id })).toEqual([before]);
    } finally {
      await ds.query(`
        DROP TRIGGER test_reject_retry_job ON jobs;
        DROP FUNCTION test_reject_retry_job();`);
    }
    expect((await call('POST', path)).status).toBe(202);
    expect(await jobs.findBy({ executionId: id })).toMatchObject([
      { status: 'queued', attempts: 0 },
    ]);
  });
});
