import { DataSource } from 'typeorm';
import { WorkerModule } from '../../src/app.module';
import { JobQueueService } from '../../src/engine/job-queue.service';
import { Execution, Job, StepRun } from '../../src/entities';
import { SchedulerService } from '../../src/scheduler/scheduler.service';
import { RunningApp, startApp } from '../helpers/app';
import {
  createExecution,
  createTenant,
  createWorkflow,
  openTestDataSource,
  TestTenant,
  truncateAll,
} from '../helpers/db';
import { configureNotifications } from '../helpers/notifications';
import { api, Receiver, startWorker, waitFor } from '../helpers/queue';

interface EventRow {
  id: string;
  executionId: string;
  sequence: number;
  type: string;
  payload: string;
  correlationId: string | null;
}

/**
 * Подія і кінцевий стан виконання фіксуються однією транзакцією на кожному фактичному шляху
 * завершення (ТЗ 3.3.9, розд. 4): воркер завершив кроки, крок провалився остаточно, задача
 * вичерпала спроби, reaper завершив чи провалив виконання з простроченим lease. Відкат не лишає
 * події, повтор того самого переходу не дає другої, ручний /retry — новий цикл.
 */
describe('outbox events are written with the terminal transition', () => {
  let ds: DataSource;
  let apiApp: RunningApp;
  let worker: RunningApp | undefined;
  const receiver = new Receiver();
  let tenant: TestTenant;
  let upstreamUp: boolean;

  beforeAll(async () => {
    ds = await openTestDataSource();
    apiApp = await startApp();
    apiApp.app.get(SchedulerService).onApplicationShutdown();
    await receiver.start();
  });
  beforeEach(async () => {
    await truncateAll(ds);
    tenant = await createTenant(ds);
    upstreamUp = true;
    receiver.respond = (req, res) => {
      if (req.path === '/upstream' && !upstreamUp)
        return void res.writeHead(500).end();
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    };
    await configureNotifications(
      apiApp,
      tenant.apiKey,
      receiver.url('/notify'),
    );
  });
  afterEach(async () => {
    await worker?.close();
    worker = undefined;
    receiver.requests.length = 0;
    await ds.query('DROP TRIGGER IF EXISTS test_fail_first_done ON jobs');
    await ds.query('DROP FUNCTION IF EXISTS test_fail_first_done()');
    await ds.query('DROP SEQUENCE IF EXISTS test_fail_once');
  });
  afterAll(async () => {
    await apiApp.close();
    await receiver.stop();
    await truncateAll(ds);
    await ds.destroy();
  });

  const call = <T = unknown>(method: string, path: string, body?: unknown) =>
    api<T>(apiApp.baseUrl, tenant.apiKey, method, path, body);

  const events = (executionId: string): Promise<EventRow[]> =>
    ds.query(
      'SELECT * FROM outbox_events WHERE "executionId" = $1 ORDER BY sequence',
      [executionId],
    );

  async function run(steps: unknown[], requestId?: string): Promise<string> {
    const wf = await call<{ id: string }>('POST', '/workflows', {
      name: 'atomic',
      steps,
    });
    const res = await fetch(`${apiApp.baseUrl}/workflows/${wf.body.id}/run`, {
      method: 'POST',
      headers: {
        'x-api-key': tenant.apiKey,
        'content-type': 'application/json',
        ...(requestId ? { 'x-request-id': requestId } : {}),
      },
      body: '{}',
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  const finished = (id: string) =>
    waitFor(
      'the execution to finish',
      async () => {
        const e = await ds.getRepository(Execution).findOneByOrFail({ id });
        return ['succeeded', 'failed'].includes(e.status);
      },
      { timeoutMs: 20_000 },
    );

  it('worker finish: one succeeded event with the correlation id of the request', async () => {
    worker = await startWorker();
    const id = await run([{ id: 'say', type: 'log', message: 'hi' }], 'req-a1');
    await finished(id);
    const [event, ...more] = await events(id);
    expect(more).toEqual([]);
    expect(event).toMatchObject({
      sequence: 1,
      type: 'execution.succeeded',
      correlationId: 'req-a1',
    });
    expect(JSON.parse(event.payload)).toMatchObject({
      id: event.id,
      correlationId: 'req-a1',
      data: { executionId: id, status: 'succeeded', sequence: 1 },
    });
  });

  it('final step failure: one failed event with the error', async () => {
    worker = await startWorker();
    // Внутрішня адреса: неповторювана помилка кроку.
    const id = await run([
      { id: 'probe', type: 'http', url: 'http://10.0.0.1/' },
    ]);
    await finished(id);
    const [event, ...more] = await events(id);
    expect(more).toEqual([]);
    expect(event.type).toBe('execution.failed');
    expect(
      (JSON.parse(event.payload) as { data: { error: string } }).data.error,
    ).toContain('not allowed');
  });

  it('attempts exhausted (dead): one failed event, not one per attempt', async () => {
    upstreamUp = false;
    worker = await startWorker();
    const id = await run([
      { id: 'call', type: 'http', url: receiver.url('/upstream') },
    ]);
    await finished(id);
    expect(receiver.hits('/upstream').length).toBe(3);
    const rows = await events(id);
    expect(rows.map((r) => [r.sequence, r.type])).toEqual([
      [1, 'execution.failed'],
    ]);
  });

  it('manual retry: a new cycle gets a new event with the next sequence', async () => {
    upstreamUp = false;
    worker = await startWorker();
    const id = await run([
      { id: 'call', type: 'http', url: receiver.url('/upstream') },
    ]);
    await finished(id);
    const [first] = await events(id);
    upstreamUp = true;
    expect((await call('POST', `/executions/${id}/retry`)).status).toBe(202);
    await waitFor('the retried execution to succeed', async () => {
      const e = await ds.getRepository(Execution).findOneByOrFail({ id });
      return e.status === 'succeeded';
    });
    const rows = await events(id);
    expect(rows.map((r) => [r.sequence, r.type])).toEqual([
      [1, 'execution.failed'],
      [2, 'execution.succeeded'],
    ]);
    // Подія першого циклу не змінилась.
    expect(rows[0]).toEqual(first);
    expect(rows[1].id).not.toBe(first.id);
  });

  async function expiredJob(attempts: number, stepDone: boolean) {
    const wf = await createWorkflow(ds, tenant.tenant.id);
    const execution = await createExecution(ds, wf, { status: 'running' });
    if (stepDone)
      await ds.getRepository(StepRun).save({
        executionId: execution.id,
        tenantId: tenant.tenant.id,
        stepIndex: 0,
        stepId: 'say',
        status: 'succeeded',
        attempts: 1,
        output: { ok: true },
        finishedAt: new Date(),
      });
    await ds.getRepository(Job).save({
      tenantId: tenant.tenant.id,
      executionId: execution.id,
      status: 'running',
      attempts,
      maxAttempts: 3,
      lockedBy: 'gone',
      lockToken: '00000000-0000-4000-8000-00000000dead',
      lockedUntil: new Date(Date.now() - 60_000),
      correlationId: 'req-reaped',
    });
    return execution.id;
  }

  it('lease reaper: finishes or fails an abandoned execution with one event each', async () => {
    const done = await expiredJob(1, true);
    const dead = await expiredJob(3, false);
    worker = await startApp(WorkerModule);
    const outcomes = await worker.app.get(JobQueueService).reapExpired();
    expect(outcomes.map((o) => o.outcome).sort()).toEqual(['dead', 'done']);
    expect((await events(done)).map((r) => r.type)).toEqual([
      'execution.succeeded',
    ]);
    expect((await events(dead)).map((r) => r.type)).toEqual([
      'execution.failed',
    ]);
    expect((await events(done))[0].correlationId).toBe('req-reaped');
    // Повторний прохід reaper-а не дає другої події.
    await worker.app.get(JobQueueService).reapExpired();
    expect(await events(done)).toHaveLength(1);
    expect(await events(dead)).toHaveLength(1);
  });

  it('a rolled-back completion leaves no event, and the completion that commits leaves one', async () => {
    await ds.query('CREATE SEQUENCE test_fail_once');
    await ds.query(`
      CREATE FUNCTION test_fail_first_done() RETURNS trigger AS $$
      BEGIN
        IF NEW.status = 'done' AND nextval('test_fail_once') = 1 THEN
          RAISE EXCEPTION 'simulated crash while finishing the job';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public`);
    await ds.query('REVOKE ALL ON FUNCTION test_fail_first_done() FROM PUBLIC');
    await ds.query(`CREATE TRIGGER test_fail_first_done BEFORE UPDATE ON jobs
      FOR EACH ROW EXECUTE FUNCTION test_fail_first_done()`);
    worker = await startWorker();
    const id = await run([{ id: 'say', type: 'log', message: 'hi' }]);
    // Перша транзакція завершення (виконання + задача + подія) відкочується цілком.
    await waitFor('the first completion to fail', async () => {
      // Нова послідовність має last_value = 1 ще до першого nextval: дивимось is_called.
      const [{ called }]: Array<{ called: boolean }> = await ds.query(
        'SELECT is_called AS called FROM test_fail_once',
      );
      return called;
    });
    // Lease (1,5 с) ще чинний, тож reaper не встиг довершити: виконання не завершене, події немає.
    const execution = await ds.getRepository(Execution).findOneByOrFail({ id });
    expect(execution.status).toBe('running');
    expect(await events(id)).toEqual([]);
    // Задачу довершує reaper (усі кроки закомічені) — і лише тоді з'являється одна подія.
    await finished(id);
    await waitFor(
      'the event of the committed completion',
      async () => (await events(id)).length > 0,
    );
    expect((await events(id)).map((r) => r.sequence)).toEqual([1]);
  });

  it('creates no event while notifications are disabled or for completions before they existed', async () => {
    worker = await startWorker();
    const before = await (async () => {
      await call('DELETE', '/tenants/me/notifications');
      const id = await run([{ id: 'say', type: 'log', message: 'hi' }]);
      await finished(id);
      return id;
    })();
    await configureNotifications(
      apiApp,
      tenant.apiKey,
      receiver.url('/notify'),
      false,
    );
    const disabled = await run([{ id: 'say', type: 'log', message: 'hi' }]);
    await finished(disabled);
    expect(await events(before)).toEqual([]);
    expect(await events(disabled)).toEqual([]);
  });
});
