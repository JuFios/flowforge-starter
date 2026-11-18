import { DataSource } from 'typeorm';
import { CheckpointService } from '../../src/engine/checkpoint.service';
import { JobRunnerService } from '../../src/engine/job-runner.service';
import { JobQueueService } from '../../src/engine/job-queue.service';
import { Job } from '../../src/entities';
import { AppModule, WorkerModule } from '../../src/app.module';
import { Execution, StepRun } from '../../src/entities';
import { RunningApp, startApp } from '../helpers/app';
import { createTenant, openTestDataSource, truncateAll } from '../helpers/db';
import { api, Receiver, startWorker, waitFor } from '../helpers/queue';

describe('durable execution', () => {
  let ds: DataSource;
  let apiApp: RunningApp;
  let worker: RunningApp | undefined;
  const receiver = new Receiver();
  let apiKey: string;

  beforeAll(async () => {
    ds = await openTestDataSource();
    apiApp = await startApp(AppModule);
    await receiver.start();
  });

  beforeEach(async () => {
    await truncateAll(ds);
    ({ apiKey } = await createTenant(ds));
  });

  afterEach(async () => {
    await worker?.close();
    worker = undefined;
    receiver.requests.length = 0;
    receiver.respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    };
  });

  afterAll(async () => {
    await apiApp.close();
    await receiver.stop();
    await ds.destroy();
  });

  async function createWorkflow(steps: unknown[]): Promise<string> {
    const res = await api<{ id: string }>(
      apiApp.baseUrl,
      apiKey,
      'POST',
      '/workflows',
      { name: 'durable', steps },
    );
    expect(res.status).toBe(201);
    return res.body.id;
  }

  async function run(workflowId: string, input = {}): Promise<string> {
    const res = await api<{ id: string }>(
      apiApp.baseUrl,
      apiKey,
      'POST',
      `/workflows/${workflowId}/run`,
      input,
    );
    return res.body.id;
  }

  function finished(id: string) {
    return waitFor(`execution ${id} to finish`, async () => {
      const e = await ds.getRepository(Execution).findOneByOrFail({ id });
      return e.status === 'succeeded' || e.status === 'failed';
    });
  }

  it('resumes a retried execution from the first unfinished step without repeating completed ones', async () => {
    let flakyCalls = 0;
    receiver.respond = (req, res) => {
      if (req.path === '/flaky' && ++flakyCalls === 1) {
        res.writeHead(503).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ path: req.path }));
    };
    const wf = await createWorkflow([
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
        url: receiver.url('/flaky'),
      },
    ]);
    const id = await run(wf);
    worker = await startWorker(1);
    await finished(id);

    const execution = await ds.getRepository(Execution).findOneByOrFail({ id });
    expect(execution.status).toBe('succeeded');
    // Платіж (зовнішній ефект) — один раз, хоча задачу повторено.
    expect(receiver.hits('/charge')).toHaveLength(1);
    expect(receiver.hits('/flaky')).toHaveLength(2);
    const steps = await ds
      .getRepository(StepRun)
      .find({ where: { executionId: id }, order: { stepIndex: 'ASC' } });
    expect(steps.map((s) => [s.stepId, s.status])).toEqual([
      ['charge', 'succeeded'],
      ['notify', 'succeeded'],
    ]);
  });

  it('keeps a committed checkpoint when its acknowledgement is lost on the last attempt', async () => {
    const wf = await createWorkflow([
      { id: 'charge', type: 'http', url: receiver.url('/charge') },
      { id: 'next', type: 'log', message: 'done' },
    ]);
    const id = await run(wf);
    await ds.getRepository(Job).update({ executionId: id }, { maxAttempts: 1 });
    worker = await startApp(WorkerModule);
    const checkpoints = worker.app.get(CheckpointService);
    const commit = checkpoints.checkpoint.bind(checkpoints);
    jest
      .spyOn(checkpoints, 'checkpoint')
      .mockImplementationOnce(async (...args) => {
        await commit(...args);
        throw new Error('connection lost after COMMIT');
      });
    worker.app.get(JobRunnerService).start(1);
    await finished(id);
    expect(
      await ds.getRepository(Execution).findOneByOrFail({ id }),
    ).toMatchObject({ status: 'succeeded' });
    expect(receiver.hits('/charge')).toHaveLength(1);
    expect(
      await ds
        .getRepository(StepRun)
        .findOneByOrFail({ executionId: id, stepIndex: 0 }),
    ).toMatchObject({
      status: 'succeeded',
      attempts: 1,
      output: { status: 200, body: { ok: true } },
      error: null,
    });
  });

  it('keeps the HTTP request body byte-identical when rebuilding context from a checkpoint', async () => {
    let calls = 0;
    receiver.respond = (req, res) => {
      if (req.path === '/fetch') {
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end('{"z":1,"a":2}');
        return;
      }
      res.writeHead(++calls === 1 ? 503 : 200).end('{}');
    };
    const id = await run(
      await createWorkflow([
        { id: 'fetch', type: 'http', url: receiver.url('/fetch') },
        {
          id: 'pay',
          type: 'http',
          method: 'POST',
          url: receiver.url('/pay'),
          body: '{{ steps.fetch.body }}',
        },
      ]),
    );
    worker = await startWorker(1);
    await finished(id);
    const hits = receiver.hits('/pay');
    expect(hits).toHaveLength(2);
    expect(JSON.parse(hits[0].body)).toEqual({ z: 1, a: 2 });
    expect(hits[1].body).toBe(hits[0].body);
    expect(hits[1].headers['idempotency-key']).toBe(
      hits[0].headers['idempotency-key'],
    );
  });

  it('preserves the only attempt of the next step when the worker vanishes between steps', async () => {
    const id = await run(
      await createWorkflow([
        { id: 'a', type: 'log', message: 'first' },
        { id: 'b', type: 'http', url: receiver.url('/next') },
      ]),
    );
    await ds.getRepository(Job).update({ executionId: id }, { maxAttempts: 1 });
    worker = await startApp(WorkerModule);
    const queue = worker.app.get(JobQueueService);
    const cp = worker.app.get(CheckpointService);
    const job = (await queue.claimNext('gone'))!;
    await cp.checkpoint(job, await cp.startStep(job, 0, 'a'), { logged: true });
    await ds.query(
      `UPDATE jobs SET "lockedUntil"=now()-interval '1 second' WHERE id=$1`,
      [job.id],
    );
    await queue.reapExpired();
    worker.app.get(JobRunnerService).start(1);
    await finished(id);
    expect(receiver.hits('/next')).toHaveLength(1);
    expect(
      await ds.getRepository(Execution).findOneByOrFail({ id }),
    ).toMatchObject({ status: 'succeeded' });
  });

  it.each([
    ['an http step', { id: 'call', type: 'http', url: 'http://127.0.0.1:1/' }],
    ['a delay step', { id: 'wait', type: 'delay', ms: 10 }],
  ])(
    'marks %s failed when the acknowledgement of its start is lost on the last attempt',
    async (_case, step) => {
      const id = await run(await createWorkflow([step]));
      await ds
        .getRepository(Job)
        .update({ executionId: id }, { maxAttempts: 1 });
      worker = await startApp(WorkerModule);
      const checkpoints = worker.app.get(CheckpointService);
      const start = checkpoints.startStep.bind(checkpoints);
      jest
        .spyOn(checkpoints, 'startStep')
        .mockImplementationOnce(async (...args) => {
          await start(...args);
          throw new Error('connection lost after COMMIT');
        });
      worker.app.get(JobRunnerService).start(1);
      await finished(id);
      expect(
        await ds.getRepository(Job).findOneByOrFail({ executionId: id }),
      ).toMatchObject({ status: 'dead', attempts: 1 });
      const execution = await ds
        .getRepository(Execution)
        .findOneByOrFail({ id });
      expect(execution.status).toBe('failed');
      expect(execution.error).toMatch(/no attempts left \(1\/1\)/);
      const stepRun = await ds
        .getRepository(StepRun)
        .findOneByOrFail({ executionId: id });
      expect(stepRun).toMatchObject({ status: 'failed', attempts: 1 });
      expect(stepRun.finishedAt).not.toBeNull();
    },
  );

  it('marks a delay step failed when parking rolls back on the last attempt', async () => {
    const id = await run(
      await createWorkflow([{ id: 'wait', type: 'delay', ms: 10 }]),
    );
    await ds.getRepository(Job).update({ executionId: id }, { maxAttempts: 1 });
    worker = await startApp(WorkerModule);
    jest
      .spyOn(worker.app.get(CheckpointService), 'park')
      .mockRejectedValueOnce(new Error('park rolled back'));
    worker.app.get(JobRunnerService).start(1);
    await finished(id);
    expect(
      await ds.getRepository(Job).findOneByOrFail({ executionId: id }),
    ).toMatchObject({ status: 'dead' });
    expect(
      await ds.getRepository(StepRun).findOneByOrFail({ executionId: id }),
    ).toMatchObject({ status: 'failed' });
  });

  it('runs the workflow version that was current when the execution started', async () => {
    const wf = await createWorkflow([
      { id: 'call', type: 'http', url: receiver.url('/v1') },
    ]);
    const id = await run(wf);
    const patched = await api(
      apiApp.baseUrl,
      apiKey,
      'PATCH',
      `/workflows/${wf}`,
      { steps: [{ id: 'other', type: 'http', url: receiver.url('/v2') }] },
    );
    expect(patched.status).toBe(200);

    worker = await startWorker(1);
    await finished(id);

    expect(
      (await ds.getRepository(Execution).findOneByOrFail({ id })).status,
    ).toBe('succeeded');
    expect(receiver.hits('/v1')).toHaveLength(1);
    expect(receiver.hits('/v2')).toHaveLength(0);
  });

  it('finishes an execution whose workflow was deleted after it started', async () => {
    const wf = await createWorkflow([
      { id: 'call', type: 'http', url: receiver.url('/kept') },
    ]);
    const id = await run(wf);
    const deleted = await api(
      apiApp.baseUrl,
      apiKey,
      'DELETE',
      `/workflows/${wf}`,
    );
    expect(deleted.status).toBe(204);

    worker = await startWorker(1);
    await finished(id);

    expect(
      (await ds.getRepository(Execution).findOneByOrFail({ id })).status,
    ).toBe('succeeded');
    expect(receiver.hits('/kept')).toHaveLength(1);
  });

  it('sends one stable Idempotency-Key for all attempts of a step, unique per step and execution', async () => {
    let payCalls = 0;
    receiver.respond = (req, res) => {
      if (req.path === '/pay' && ++payCalls <= 2) {
        res.writeHead(503).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    };
    const wf = await createWorkflow([
      { id: 'pay', type: 'http', method: 'POST', url: receiver.url('/pay') },
      {
        id: 'notify',
        type: 'http',
        method: 'POST',
        url: receiver.url('/notify'),
      },
    ]);
    const first = await run(wf);
    worker = await startWorker(1);
    await finished(first);
    const second = await run(wf);
    await finished(second);

    const keys = (path: string) =>
      receiver.hits(path).map((r) => r.headers['idempotency-key']);
    const pay = keys('/pay');
    const notify = keys('/notify');
    // 3 спроби першого виконання (дві 503 і успіх) + 1 спроба другого.
    expect(pay).toHaveLength(4);
    expect(new Set(pay.slice(0, 3)).size).toBe(1);
    expect(pay[3]).not.toBe(pay[0]);
    expect(notify).toHaveLength(2);
    expect(new Set([pay[0], pay[3], ...notify]).size).toBe(4);

    const stored = await ds
      .getRepository(StepRun)
      .findOneByOrFail({ executionId: first, stepId: 'pay' });
    expect(stored).toMatchObject({ idempotencyKey: pay[0], attempts: 3 });
  });
});
