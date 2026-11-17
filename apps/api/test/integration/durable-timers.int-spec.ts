import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { Execution, StepRun } from '../../src/entities';
import { RunningApp, startApp } from '../helpers/app';
import { createTenant, openTestDataSource, truncateAll } from '../helpers/db';
import { api, startWorker, waitFor } from '../helpers/queue';

describe('delay steps are durable timers', () => {
  let ds: DataSource;
  let apiApp: RunningApp;
  let workers: RunningApp[] = [];
  let apiKey: string;

  beforeAll(async () => {
    ds = await openTestDataSource();
    apiApp = await startApp(AppModule);
  });

  beforeEach(async () => {
    await truncateAll(ds);
    ({ apiKey } = await createTenant(ds));
  });

  afterEach(async () => {
    await Promise.all(workers.map((w) => w.close()));
    workers = [];
  });

  afterAll(async () => {
    await apiApp.close();
    await ds.destroy();
  });

  async function start(steps: unknown[]): Promise<string> {
    const wf = await api<{ id: string }>(
      apiApp.baseUrl,
      apiKey,
      'POST',
      '/workflows',
      { name: 'timer', steps },
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

  const execution = (id: string) =>
    ds.getRepository(Execution).findOneByOrFail({ id });

  it('does not hold a worker slot while waiting', async () => {
    const sleeping = await start([
      { id: 'wait', type: 'delay', ms: 3_000 },
      { id: 'after', type: 'log', message: 'woke up' },
    ]);
    const quick = await start([{ id: 'say', type: 'log', message: 'quick' }]);
    // Один слот на весь воркер: поки delay його тримав би, друге виконання стояло б.
    workers.push(await startWorker(1));

    await waitFor(
      'the quick execution to finish while the other one sleeps',
      async () => (await execution(quick)).status === 'succeeded',
      { timeoutMs: 1_500 },
    );
    expect((await execution(sleeping)).status).not.toBe('succeeded');

    await waitFor(
      'the sleeping execution to wake up and finish',
      async () => (await execution(sleeping)).status === 'succeeded',
    );
  });

  it('wakes up at the original time after the worker is restarted', async () => {
    const id = await start([
      { id: 'wait', type: 'delay', ms: 2_500 },
      { id: 'after', type: 'log', message: 'woke up' },
    ]);
    const first = await startWorker(1);
    await waitFor('the delay step to start', async () =>
      ds.getRepository(StepRun).existsBy({ executionId: id, stepId: 'wait' }),
    );
    const { startedAt } = await ds
      .getRepository(StepRun)
      .findOneByOrFail({ executionId: id, stepId: 'wait' });
    // Перезапуск воркера посеред паузи.
    await first.close();
    workers.push(await startWorker(1));

    await waitFor(
      'the execution to finish after the restart',
      async () => (await execution(id)).status === 'succeeded',
    );
    const { finishedAt } = await execution(id);
    const waited = finishedAt!.getTime() - startedAt.getTime();
    // Не раніше за заявлену паузу і без відліку заново після перезапуску.
    expect(waited).toBeGreaterThanOrEqual(2_500);
    expect(waited).toBeLessThan(3_500);
  });
});
