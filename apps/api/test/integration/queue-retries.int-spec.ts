import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { Execution, Job, StepRun } from '../../src/entities';
import { RunningApp, startApp } from '../helpers/app';
import { createTenant, openTestDataSource, truncateAll } from '../helpers/db';
import { api, Receiver, startWorker, waitFor } from '../helpers/queue';

/** JOB_MAX_ATTEMPTS у тестах — 3. */
describe('retries and the attempt limit', () => {
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
  });

  afterAll(async () => {
    await apiApp.close();
    await receiver.stop();
    await ds.destroy();
  });

  async function start(
    steps: unknown[],
    input: Record<string, unknown> = {},
  ): Promise<string> {
    const wf = await api<{ id: string }>(
      apiApp.baseUrl,
      apiKey,
      'POST',
      '/workflows',
      { name: 'retries', steps },
    );
    const run = await api<{ id: string }>(
      apiApp.baseUrl,
      apiKey,
      'POST',
      `/workflows/${wf.body.id}/run`,
      input,
    );
    return run.body.id;
  }

  const finished = (id: string) =>
    waitFor('the execution to finish', async () =>
      ['succeeded', 'failed'].includes(
        (await ds.getRepository(Execution).findOneByOrFail({ id })).status,
      ),
    );

  it('moves a job that keeps failing with a temporary error to the dead state after the limit', async () => {
    receiver.respond = (_req, res) => void res.writeHead(503).end();
    const id = await start([
      { id: 'call', type: 'http', url: receiver.url('/down') },
    ]);
    worker = await startWorker(1);
    await finished(id);

    expect(receiver.hits('/down')).toHaveLength(3);
    const job = await ds
      .getRepository(Job)
      .findOneByOrFail({ executionId: id });
    expect(job).toMatchObject({
      status: 'dead',
      attempts: 3,
      lastError: 'http 503',
    });
    // Момент завершення — для видалення після терміну зберігання.
    expect(job.finishedAt).toBeInstanceOf(Date);
    const execution = await ds.getRepository(Execution).findOneByOrFail({ id });
    expect(execution.status).toBe('failed');
    expect(execution.error).toContain('no attempts left (3/3)');
    const step = await ds
      .getRepository(StepRun)
      .findOneByOrFail({ executionId: id });
    expect(step).toMatchObject({ status: 'failed', attempts: 3 });
  });

  it('fails a job with a permanent error at once, without retries', async () => {
    receiver.respond = (_req, res) => void res.writeHead(404).end();
    const id = await start([
      { id: 'call', type: 'http', url: receiver.url('/missing') },
    ]);
    worker = await startWorker(1);
    await finished(id);

    expect(receiver.hits('/missing')).toHaveLength(1);
    expect(
      await ds.getRepository(Job).findOneByOrFail({ executionId: id }),
    ).toMatchObject({
      status: 'failed',
      attempts: 1,
      finishedAt: expect.any(Date) as Date,
    });
  });

  it('fails at once when the input turns the url into an invalid one', async () => {
    const id = await start(
      [{ id: 'call', type: 'http', url: 'http://{{ input.host }}/hook' }],
      { host: 'receiver with spaces' },
    );
    worker = await startWorker(1);
    await finished(id);

    expect(
      await ds.getRepository(Job).findOneByOrFail({ executionId: id }),
    ).toMatchObject({ status: 'failed', attempts: 1 });
    expect(
      await ds.getRepository(Execution).findOneByOrFail({ id }),
    ).toMatchObject({
      status: 'failed',
      error: 'http url is invalid after template substitution',
    });
  });

  it('gives each step its own attempt budget', async () => {
    // Кожен крок падає двічі (з трьох дозволених спроб) — разом 6 невдач, але workflow завершиться.
    const calls = new Map<string, number>();
    receiver.respond = (req, res) => {
      const n = (calls.get(req.path) ?? 0) + 1;
      calls.set(req.path, n);
      if (n <= 2) return void res.writeHead(503).end();
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    };
    const id = await start([
      { id: 'a', type: 'http', url: receiver.url('/a') },
      { id: 'b', type: 'http', url: receiver.url('/b') },
      { id: 'c', type: 'http', url: receiver.url('/c') },
    ]);
    worker = await startWorker(1);
    await finished(id);

    expect(
      (await ds.getRepository(Execution).findOneByOrFail({ id })).status,
    ).toBe('succeeded');
    expect([...calls.values()]).toEqual([3, 3, 3]);
  });

  it('declares a job dead when its lease expires on the last attempt', async () => {
    const id = await start([{ id: 'say', type: 'log', message: 'hi' }]);
    await ds.query(
      `UPDATE jobs SET status = 'running', "lockedBy" = 'crashed', attempts = 3,
              "lockedUntil" = now() - interval '1 second'
        WHERE "executionId" = $1`,
      [id],
    );
    worker = await startWorker(1);
    await finished(id);

    expect(
      await ds.getRepository(Job).findOneByOrFail({ executionId: id }),
    ).toMatchObject({ status: 'dead', lockedBy: null });
    const execution = await ds.getRepository(Execution).findOneByOrFail({ id });
    expect(execution.status).toBe('failed');
    expect(execution.error).toMatch(/lease expired: worker crashed/);
  });
});
