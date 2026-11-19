import { signedHeaders } from '../helpers/webhook';
import { DataSource } from 'typeorm';
import { WorkerModule } from '../../src/app.module';
import { JobQueueService } from '../../src/engine/job-queue.service';
import { Execution, Job } from '../../src/entities';
import { SchedulerService } from '../../src/scheduler/scheduler.service';
import { RunningApp, startApp } from '../helpers/app';
import {
  createExecution,
  createWorkflow,
  openTestDataSource,
  truncateAll,
} from '../helpers/db';
import { api, Receiver, sleep, startWorker, waitFor } from '../helpers/queue';
import { TEST_ADMIN_TOKEN } from '../helpers/test-env';

/**
 * Кожна операція з матриці прав (README, «Операції → права») справді виконується справжніми
 * runtime-ролями на непорожніх даних: матриця не лише збігається з каталогом (db-acl), а й
 * достатня для роботи API, воркера, reaper-а й очищення.
 */
describe('every operation works with the runtime roles', () => {
  let owner: DataSource;
  let apiApp: RunningApp;
  let worker: RunningApp | undefined;
  const receiver = new Receiver();

  beforeAll(async () => {
    owner = await openTestDataSource();
    apiApp = await startApp();
    await receiver.start();
  });

  beforeEach(() => truncateAll(owner));

  afterEach(async () => {
    await worker?.close();
    worker = undefined;
    receiver.requests.length = 0;
  });

  afterAll(async () => {
    await apiApp.close();
    await receiver.stop();
    await truncateAll(owner);
    await owner.destroy();
  });

  /** Новий тенант через адмін-ендпоінт (API-роль у контексті нового тенанта). */
  async function newTenant(): Promise<{
    id: string;
    apiKey: string;
    webhookSecret: string;
  }> {
    const res = await fetch(`${apiApp.baseUrl}/tenants`, {
      method: 'POST',
      headers: {
        'x-admin-token': TEST_ADMIN_TOKEN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'ops' }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as {
      id: string;
      apiKey: string;
      webhookSecret: string;
    };
  }

  const execution = (id: string) =>
    owner.getRepository(Execution).findOneByOrFail({ id });

  it('API and worker: tenant, workflows, runs with every step kind, failure, retry, webhook, scheduler', async () => {
    const tenant = await newTenant();
    const call = <T = unknown>(method: string, path: string, body?: unknown) =>
      api<T>(apiApp.baseUrl, tenant.apiKey, method, path, body);

    // http-крок спершу падає (повтор із backoff), потім проходить.
    receiver.respond = (req, res) => {
      if (receiver.hits(req.path).length === 1)
        return void res.writeHead(503).end();
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end('{"ok":1}');
    };
    const wf = await call<{ id: string }>('POST', '/workflows', {
      name: 'ops',
      steps: [
        { id: 'say', type: 'log', message: 'hi {{ input.name }}' },
        { id: 'pause', type: 'delay', ms: 100 },
        { id: 'call', type: 'http', url: receiver.url('/ops') },
        { id: 'shape', type: 'transform', expr: 'ctx.steps.call.status' },
      ],
    });
    expect(wf.status).toBe(201);
    expect(
      (await call('PATCH', `/workflows/${wf.body.id}`, { name: 'ops2' }))
        .status,
    ).toBe(200);
    expect((await call<unknown[]>('GET', '/workflows')).body).toHaveLength(1);

    const run = await call<{ id: string }>(
      'POST',
      `/workflows/${wf.body.id}/run`,
      {
        name: 'Ada',
      },
    );
    expect(run.status).toBe(201);
    worker = await startWorker(2);
    await waitFor(
      'the run to succeed',
      async () => (await execution(run.body.id)).status === 'succeeded',
    );
    const detail = await call<{ steps: Array<{ status: string }> }>(
      'GET',
      `/executions/${run.body.id}`,
    );
    expect(detail.body.steps.map((s) => s.status)).toEqual([
      'succeeded',
      'succeeded',
      'succeeded',
      'succeeded',
    ]);
    expect((await call<unknown[]>('GET', '/executions')).body).toHaveLength(1);

    // Неповторювана помилка → failed → /retry продовжує (API: execution FOR UPDATE, jobs).
    receiver.respond = (_req, res) => void res.writeHead(400).end();
    const failing = await call<{ id: string }>('POST', '/workflows', {
      name: 'fails',
      steps: [{ id: 'call', type: 'http', url: receiver.url('/bad') }],
    });
    const bad = await call<{ id: string }>(
      'POST',
      `/workflows/${failing.body.id}/run`,
      {},
    );
    await waitFor(
      'the run to fail',
      async () => (await execution(bad.body.id)).status === 'failed',
    );
    receiver.respond = (_req, res) => void res.writeHead(200).end('{}');
    expect(
      (await call('POST', `/executions/${bad.body.id}/retry`)).status,
    ).toBe(202);
    await waitFor(
      'the retried run to succeed',
      async () => (await execution(bad.body.id)).status === 'succeeded',
    );

    // Webhook: тенант адресата — definer-функцією, решта — у його контексті.
    const body = { from: 'hook' };
    const hook = await fetch(`${apiApp.baseUrl}/hooks/${wf.body.id}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...signedHeaders(
          wf.body.id,
          tenant.webhookSecret,
          JSON.stringify(body),
        ),
      },
      body: JSON.stringify(body),
    });
    expect(hook.status).toBe(202);

    // Планувальник: сторінки due_schedule_tenants, workflow і курсор — у контексті тенанта.
    await call('PATCH', `/workflows/${failing.body.id}`, {
      cron: '* * * * * *',
    });
    await sleep(1_500);
    const fired = await apiApp.app.get(SchedulerService).tick();
    expect(fired).toBeGreaterThan(0);

    expect((await call('DELETE', `/workflows/${failing.body.id}`)).status).toBe(
      204,
    );
  });

  it('worker maintenance: reaper, release and both cleanups', async () => {
    const tenant = await newTenant();
    const wf = await createWorkflow(owner, tenant.id);
    // Воркер без циклів обробки: операції викликаються напряму, під роллю воркера.
    worker = await startApp(WorkerModule);
    const queue = worker.app.get(JobQueueService);

    // Reaper: прострочений lease іншого воркера.
    const lost = await createExecution(owner, wf, { status: 'running' });
    await owner.getRepository(Job).save({
      tenantId: tenant.id,
      executionId: lost.id,
      status: 'running',
      attempts: 1,
      lockedBy: 'gone',
      lockToken: '00000000-0000-4000-8000-00000000dead',
      lockedUntil: new Date(Date.now() - 60_000),
    });
    expect((await queue.reapExpired()).map((r) => r.executionId)).toEqual([
      lost.id,
    ]);

    // Захоплення й повернення в чергу при завершенні воркера.
    // Reaper повернув задачу з backoff (50–500 мс у тестах) — захоплюємо, щойно вона готова.
    let claimed: Awaited<ReturnType<JobQueueService['claimNext']>> = null;
    await waitFor('the reaped job to be claimable', async () => {
      claimed = await queue.claimNext('ops-worker');
      return Boolean(claimed);
    });
    expect(claimed!.executionId).toBe(lost.id);
    await queue.release(claimed!);
    expect(
      await owner.getRepository(Job).findOneByOrFail({ executionId: lost.id }),
    ).toMatchObject({
      status: 'queued',
    });

    // Очищення: завершені задачі й історія виконань, старші за термін.
    const old = await createExecution(owner, wf, { status: 'succeeded' });
    await owner.query(
      `UPDATE executions SET "finishedAt" = now() - interval '40 days' WHERE id = $1`,
      [old.id],
    );
    await owner.getRepository(Job).save({
      tenantId: tenant.id,
      executionId: old.id,
      status: 'done',
      finishedAt: new Date(Date.now() - 40 * 86_400_000),
    });
    expect(await queue.purgeFinished(30)).toBe(1);
    expect(await queue.purgeExecutions(30)).toBe(1);
    expect(await owner.getRepository(Execution).countBy({ id: old.id })).toBe(
      0,
    );
  });
});
