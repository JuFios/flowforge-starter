import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { Execution, Job } from '../../src/entities';
import { RunningApp, startApp } from '../helpers/app';
import { createTenant, openTestDataSource, truncateAll } from '../helpers/db';
import { api, startWorker, waitFor } from '../helpers/queue';

describe('a job whose worker vanished', () => {
  let ds: DataSource;
  let apiApp: RunningApp;
  let worker: RunningApp | undefined;

  beforeAll(async () => {
    ds = await openTestDataSource();
    apiApp = await startApp(AppModule);
  });

  beforeEach(() => truncateAll(ds));

  afterEach(async () => {
    await worker?.close();
    worker = undefined;
  });

  afterAll(async () => {
    await apiApp.close();
    await ds.destroy();
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
      'the abandoned execution to be finished by the new worker',
      async () =>
        (await ds.getRepository(Execution).findOneByOrFail({ id: run.body.id }))
          .status === 'succeeded',
      { timeoutMs: 10_000 },
    );
    const job = await ds
      .getRepository(Job)
      .findOneByOrFail({ executionId: run.body.id });
    expect(job.status).toBe('done');
    expect(job.lockedBy).toBeNull();
  });
});
