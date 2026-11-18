import { DataSource } from 'typeorm';
import { JobQueueService } from '../../src/engine/job-queue.service';
import { JobRunnerService } from '../../src/engine/job-runner.service';
import { AppModule, WorkerModule } from '../../src/app.module';
import { Execution, Job } from '../../src/entities';
import { RunningApp, startApp } from '../helpers/app';
import { createTenant, openTestDataSource, truncateAll } from '../helpers/db';
import { api, Receiver, sleep, startWorker, waitFor } from '../helpers/queue';

/** WORKER_SHUTDOWN_GRACE_MS у тестах — 3000 мс. */
describe('worker graceful shutdown', () => {
  let ds: DataSource;
  let apiApp: RunningApp;
  let worker: RunningApp | undefined;
  const receiver = new Receiver();
  let apiKey: string;
  let workflowId: string;

  beforeAll(async () => {
    ds = await openTestDataSource();
    apiApp = await startApp(AppModule);
    await receiver.start();
  });

  beforeEach(async () => {
    await truncateAll(ds);
    ({ apiKey } = await createTenant(ds));
    const wf = await api<{ id: string }>(
      apiApp.baseUrl,
      apiKey,
      'POST',
      '/workflows',
      {
        name: 'slow',
        steps: [{ id: 'call', type: 'http', url: receiver.url('/slow') }],
      },
    );
    workflowId = wf.body.id;
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

  const run = async () =>
    (
      await api<{ id: string }>(
        apiApp.baseUrl,
        apiKey,
        'POST',
        `/workflows/${workflowId}/run`,
        {},
      )
    ).body.id;

  const jobOf = (executionId: string) =>
    ds.getRepository(Job).findOneByOrFail({ executionId });

  function respondAfter(ms: number) {
    receiver.respond = async (_req, res) => {
      await sleep(ms);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    };
  }

  it('returns a claim that completes during shutdown without executing the job', async () => {
    const id = await run();
    worker = await startApp(WorkerModule);
    const queue = worker.app.get(JobQueueService);
    const job = await queue.claimNext('pending-claim');
    expect(job).toBeTruthy();
    let resolveClaim!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolveClaim = resolve;
    });
    jest.spyOn(queue, 'claimNext').mockImplementationOnce(async () => {
      await pending;
      return job;
    });
    const runner = worker.app.get(JobRunnerService);
    runner.start(1);
    const stopped = runner.beforeApplicationShutdown();
    resolveClaim();
    await stopped;
    expect(receiver.hits('/slow')).toHaveLength(0);
    expect(await jobOf(id)).toMatchObject({
      status: 'queued',
      attempts: 0,
      lockToken: null,
    });
  });

  it('finishes the job in progress and takes no new ones while stopping', async () => {
    respondAfter(1_000);
    const inFlight = await run();
    worker = await startWorker(2);
    await waitFor(
      'the step to reach the receiver',
      () => receiver.hits('/slow').length === 1,
    );

    const stopping = worker.close();
    worker = undefined;
    const late = await run();
    await stopping;

    expect(
      (await ds.getRepository(Execution).findOneByOrFail({ id: inFlight }))
        .status,
    ).toBe('succeeded');
    expect((await jobOf(inFlight)).status).toBe('done');
    expect(await jobOf(late)).toMatchObject({ status: 'queued', attempts: 0 });
  });

  it('returns a job that outlives the grace period to the queue without spending an attempt', async () => {
    respondAfter(10_000);
    const id = await run();
    worker = await startWorker(1);
    await waitFor(
      'the step to reach the receiver',
      () => receiver.hits('/slow').length === 1,
    );

    const started = Date.now();
    await worker.close();
    worker = undefined;

    expect(Date.now() - started).toBeLessThan(5_000);
    const job = await jobOf(id);
    expect(job).toMatchObject({
      status: 'queued',
      attempts: 0,
      lockedBy: null,
      lockedUntil: null,
    });
    // Готова до захоплення одразу — за годинником БД, як і вся черга.
    const [{ ready }]: Array<{ ready: boolean }> = await ds.query(
      `SELECT "runAt" <= now() AS ready FROM jobs WHERE id = $1`,
      [job.id],
    );
    expect(ready).toBe(true);
    expect(
      (await ds.getRepository(Execution).findOneByOrFail({ id })).status,
    ).not.toBe('failed');
  });
});
