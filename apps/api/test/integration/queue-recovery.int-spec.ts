import { DataSource } from 'typeorm';
import { AppModule, WorkerModule } from '../../src/app.module';
import {
  JobQueueService,
  LeaseLostError,
} from '../../src/engine/job-queue.service';
import { Execution, Job } from '../../src/entities';
import { RunningApp, startApp } from '../helpers/app';
import { createTenant, openTestDataSource, truncateAll } from '../helpers/db';
import { api, Receiver, sleep, startWorker, waitFor } from '../helpers/queue';

describe('a job whose worker vanished', () => {
  let ds: DataSource;
  let apiApp: RunningApp;
  let worker: RunningApp | undefined;
  let others: RunningApp[] = [];
  const receiver = new Receiver();

  beforeAll(async () => {
    ds = await openTestDataSource();
    apiApp = await startApp(AppModule);
    await receiver.start();
  });

  beforeEach(() => truncateAll(ds));

  afterEach(async () => {
    await worker?.close();
    worker = undefined;
    await Promise.all(others.map((o) => o.close()));
    others = [];
    receiver.requests.length = 0;
  });

  afterAll(async () => {
    await apiApp.close();
    await receiver.stop();
    await ds.destroy();
  });

  async function runWorkflow(steps: unknown[]): Promise<string> {
    const { apiKey } = await createTenant(ds);
    const wf = await api<{ id: string }>(
      apiApp.baseUrl,
      apiKey,
      'POST',
      '/workflows',
      { name: 'lease', steps },
    );
    const run = await api<{ id: string }>(
      apiApp.baseUrl,
      apiKey,
      'POST',
      `/workflows/${wf.body.id}/run`,
      {},
    );
    return run.body.id;
  }

  it('keeps its lease while a step runs longer than the lease, so no other worker takes it', async () => {
    // JOB_LEASE_MS у тестах — 1500 мс; крок триває втричі довше.
    receiver.respond = async (_req, res) => {
      await sleep(4_500);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    };
    const id = await runWorkflow([
      { id: 'slow', type: 'http', url: receiver.url('/slow') },
    ]);
    worker = await startWorker(1);
    others.push(await startWorker(2));

    await waitFor(
      'the slow execution to succeed',
      async () =>
        (await ds.getRepository(Execution).findOneByOrFail({ id })).status ===
        'succeeded',
      { timeoutMs: 15_000 },
    );
    expect(receiver.hits('/slow')).toHaveLength(1);
    const job = await ds
      .getRepository(Job)
      .findOneByOrFail({ executionId: id });
    expect(job.attempts).toBe(1);
  });

  it('does not let a worker whose lease was taken over record the outcome', async () => {
    const id = await runWorkflow([{ id: 'say', type: 'log', message: 'hi' }]);
    const a = await startApp(WorkerModule);
    const b = await startApp(WorkerModule);
    others.push(a, b);
    const qa = a.app.get(JobQueueService);
    const qb = b.app.get(JobQueueService);

    const stale = (await qa.claimNext('worker-a'))!;
    // Воркер A «завис»: lease минув, reaper повернув задачу, її захопив B.
    await ds.query(
      `UPDATE jobs SET "lockedUntil" = now() - interval '1 second' WHERE id = $1`,
      [stale.id],
    );
    await qb.reapExpired();
    await ds.query(`UPDATE jobs SET "runAt" = now() WHERE id = $1`, [stale.id]);
    const fresh = (await qb.claimNext('worker-b'))!;
    expect(fresh.id).toBe(stale.id);

    await expect(qa.complete(stale)).rejects.toBeInstanceOf(LeaseLostError);
    await expect(qa.heartbeat(stale)).resolves.toBe(false);

    const job = await ds
      .getRepository(Job)
      .findOneByOrFail({ executionId: id });
    expect(job).toMatchObject({
      status: 'running',
      lockedBy: 'worker-b',
      lockToken: fresh.lockToken,
    });
  });

  it('is returned to the queue after its lease expires and finished by another worker', async () => {
    const { apiKey } = await createTenant(ds);
    const wf = await api<{ id: string }>(
      apiApp.baseUrl,
      apiKey,
      'POST',
      '/workflows',
      { name: 'lease', steps: [{ id: 'say', type: 'log', message: 'hi' }] },
    );
    const run = await api<{ id: string }>(
      apiApp.baseUrl,
      apiKey,
      'POST',
      `/workflows/${wf.body.id}/run`,
      {},
    );
    // Так задачу лишає воркер, якого вбили посеред обробки: running, lease уже минув.
    await ds.query(
      `UPDATE jobs SET status = 'running', "lockedBy" = 'killed-worker', attempts = 1,
              "lockedUntil" = now() - interval '1 second'
        WHERE "executionId" = $1`,
      [run.body.id],
    );

    worker = await startWorker(1);

    await waitFor(
      'the abandoned job to be finished by the new worker',
      async () =>
        (
          await ds
            .getRepository(Job)
            .findOneByOrFail({ executionId: run.body.id })
        ).status === 'done',
      { timeoutMs: 10_000 },
    );
    expect(
      (await ds.getRepository(Execution).findOneByOrFail({ id: run.body.id }))
        .status,
    ).toBe('succeeded');
    const job = await ds
      .getRepository(Job)
      .findOneByOrFail({ executionId: run.body.id });
    expect(job.status).toBe('done');
    expect(job.lockedBy).toBeNull();
  });
});
