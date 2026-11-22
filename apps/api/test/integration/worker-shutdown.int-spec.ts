import { DataSource } from 'typeorm';
import { JobQueueService } from '../../src/engine/job-queue.service';
import { JobRunnerService } from '../../src/engine/job-runner.service';
import { StepExecutor } from '../../src/engine/step-executor';
import { AppModule, WorkerModule } from '../../src/app.module';
import { Execution, Job, StepRun } from '../../src/entities';
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

  it.each([false, true])(
    'aborts a reclaimed job after the old attempt finishes (database unavailable: %s)',
    async (disconnected) => {
      const id = await run();
      worker = await startApp(WorkerModule);
      const queue = worker.app.get(JobQueueService);
      const runner = worker.app.get(JobRunnerService);
      const executor = worker.app.get(StepExecutor);
      const first = await queue.claimNext('same-worker');
      if (!first) throw new Error('first claim was not acquired');
      const heartbeat = queue.heartbeat.bind(queue);
      jest
        .spyOn(queue, 'heartbeat')
        .mockImplementation((job) =>
          job.lockToken === first.lockToken
            ? Promise.resolve(false)
            : heartbeat(job),
        );
      let finishOld!: () => void;
      const oldBarrier = new Promise<void>((resolve) => {
        finishOld = resolve;
      });
      let finishNew!: () => void;
      const newBarrier = new Promise<void>((resolve) => {
        finishNew = resolve;
      });
      let oldEntered = false;
      let freshSignal: AbortSignal | undefined;
      const execute = jest
        .spyOn(executor, 'execute')
        .mockImplementationOnce(async () => {
          oldEntered = true;
          await oldBarrier;
          return { stale: true };
        })
        .mockImplementationOnce(async (_step, _context, options) => {
          if (!options?.signal)
            throw new Error('attempt has no cancellation signal');
          const signal = options.signal;
          freshSignal = signal;
          const abort = () => finishNew();
          signal.addEventListener('abort', abort, { once: true });
          try {
            await newBarrier;
            signal.throwIfAborted();
            return { fresh: true };
          } finally {
            signal.removeEventListener('abort', abort);
          }
        });
      const old = runner.process(first);
      let fresh: Promise<void> | undefined;
      try {
        await waitFor('old attempt to reach its step', () => oldEntered);
        await ds.query(
          `UPDATE jobs SET "lockedUntil"=now() - interval '1 second' WHERE id=$1`,
          [first.id],
        );
        expect(await queue.reapExpired()).toMatchObject([{ outcome: 'retry' }]);
        let second: Awaited<ReturnType<JobQueueService['claimNext']>>;
        await waitFor('same process to reclaim the job', async () => {
          second = await queue.claimNext('same-worker');
          return !!second;
        });
        if (!second) throw new Error('second claim was not acquired');
        expect(second.id).toBe(first.id);
        expect(second.lockToken).not.toBe(first.lockToken);
        fresh = runner.process(second);
        await waitFor('new attempt to reach its step', () => !!freshSignal);
        finishOld();
        await old;
        expect(await jobOf(id)).toMatchObject({
          status: 'running',
          lockToken: second.lockToken,
        });
        expect(
          await ds.getRepository(StepRun).findOneByOrFail({ executionId: id }),
        ).toMatchObject({
          status: 'running',
          output: null,
        });

        const release = queue.release.bind(queue);
        const runtime = worker.app.get(DataSource);
        const releaseAttempt = jest
          .spyOn(queue, 'release')
          .mockImplementation(async (job) => {
            if (disconnected) await runtime.destroy();
            await release(job);
          });
        const started = performance.now();
        await runner.beforeApplicationShutdown();
        expect(freshSignal?.aborted).toBe(true);
        expect(performance.now() - started).toBeLessThan(5_000);
        expect(releaseAttempt).toHaveBeenCalledWith(second);
        await fresh;
        if (disconnected) {
          expect(await jobOf(id)).toMatchObject({
            status: 'running',
            lockToken: second.lockToken,
          });
          const recovery = await startWorker(1);
          try {
            await waitFor(
              'a different worker to finish after lease expiry',
              async () => (await jobOf(id)).status === 'done',
            );
          } finally {
            await recovery.close();
          }
        } else {
          expect(await jobOf(id)).toMatchObject({
            status: 'queued',
            lockToken: null,
          });
        }
      } finally {
        finishOld();
        finishNew();
        await Promise.allSettled([old, fresh]);
        execute.mockRestore();
      }
    },
  );

  function respondAfter(ms: number) {
    receiver.respond = async (_req, res) => {
      await sleep(ms);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    };
  }

  it('never starts a step when the claim response arrives beyond the safe lease deadline', async () => {
    const id = await run();
    worker = await startApp(WorkerModule);
    const queue = worker.app.get(JobQueueService);
    const claim = queue.claimNext.bind(queue);
    let returned = false;
    jest.spyOn(queue, 'claimNext').mockImplementation(async (owner) => {
      if (returned) return null;
      const job = await claim(owner);
      await sleep(1600);
      returned = true;
      return job;
    });
    jest
      .spyOn(queue, 'heartbeat')
      .mockImplementation(() => new Promise<boolean>(() => undefined));
    // Цей тест ізолює прострочену відповідь одного claim від роботи reaper.
    jest.spyOn(queue, 'reapExpired').mockResolvedValue([]);
    receiver.respond = (_req, res) => void res.writeHead(200).end('{}');
    const runner = worker.app.get(JobRunnerService);
    runner.start(1);
    await waitFor('late claim to return', () => returned);
    await runner.beforeApplicationShutdown();
    expect(receiver.hits('/slow')).toHaveLength(0);
    expect(
      await ds.getRepository(Execution).findOneByOrFail({ id }),
    ).toMatchObject({ status: 'pending' });
  });

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
