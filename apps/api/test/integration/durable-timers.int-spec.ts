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
      'the quick execution to finish',
      async () => (await execution(quick)).status === 'succeeded',
    );
    await waitFor(
      'the sleeping execution to wake up and finish',
      async () => (await execution(sleeping)).status === 'succeeded',
    );
    // Факти з БД (один годинник): швидке виконання завершилось раніше, ніж пауза мала скінчитись,
    // тобто єдиний слот був вільний, поки виконання з delay чекало.
    const { wakeAt } = await ds
      .getRepository(StepRun)
      .findOneByOrFail({ executionId: sleeping, stepId: 'wait' });
    const { finishedAt } = await execution(quick);
    expect(finishedAt!.getTime()).toBeLessThan(wakeAt!.getTime());
  });

  it('wakes up at the original time after the worker is restarted', async () => {
    const id = await start([
      { id: 'wait', type: 'delay', ms: 2_500 },
      { id: 'after', type: 'log', message: 'woke up' },
    ]);
    const first = await startWorker(1);
    const parked = async () =>
      ds.getRepository(StepRun).findOneBy({ executionId: id, stepId: 'wait' });
    await waitFor(
      'the delay step to be parked',
      async () => (await parked())?.wakeAt != null,
    );
    const before = (await parked())!;
    // Перезапуск воркера посеред паузи.
    await first.close();
    workers.push(await startWorker(1));

    await waitFor(
      'the execution to finish after the restart',
      async () => (await execution(id)).status === 'succeeded',
    );
    const after = (await parked())!;
    // Факти з БД: момент пробудження зафіксовано один раз на початку паузи (now() + ms) і
    // перезапуск його не зсунув; крок завершився не раніше за нього.
    expect(after.wakeAt).toEqual(before.wakeAt);
    const planned = before.wakeAt!.getTime() - before.startedAt.getTime();
    expect(planned).toBeGreaterThanOrEqual(2_500);
    expect(planned).toBeLessThan(2_500 + 1_000);
    expect(after.finishedAt!.getTime()).toBeGreaterThanOrEqual(
      before.wakeAt!.getTime(),
    );
    expect(after.attempts).toBe(1);
  });

  it('parks the job again when it is picked up before the wake-up time', async () => {
    const id = await start([
      { id: 'wait', type: 'delay', ms: 2_000 },
      { id: 'after', type: 'log', message: 'woke up' },
    ]);
    workers.push(await startWorker(1));
    await waitFor('the delay step to be parked', async () => {
      const run = await ds
        .getRepository(StepRun)
        .findOneBy({ executionId: id, stepId: 'wait' });
      return run?.wakeAt != null;
    });
    const { wakeAt } = await ds
      .getRepository(StepRun)
      .findOneByOrFail({ executionId: id, stepId: 'wait' });
    // Задача стала доступною раніше строку (напр., її повернули вручну).
    await ds.query(`UPDATE jobs SET "runAt" = now() WHERE "executionId" = $1`, [
      id,
    ]);

    await waitFor(
      'the execution to finish',
      async () => (await execution(id)).status === 'succeeded',
    );
    const { finishedAt } = await execution(id);
    expect(finishedAt!.getTime()).toBeGreaterThanOrEqual(wakeAt!.getTime());
    // Пауза не почалась заново: момент пробудження той самий, що зафіксовано на її початку.
    const step = await ds
      .getRepository(StepRun)
      .findOneByOrFail({ executionId: id, stepId: 'wait' });
    expect(step.wakeAt).toEqual(wakeAt);
    const steps = await ds
      .getRepository(StepRun)
      .find({ where: { executionId: id }, order: { stepIndex: 'ASC' } });
    expect(steps.map((s) => [s.stepId, s.status, s.attempts])).toEqual([
      ['wait', 'succeeded', 1],
      ['after', 'succeeded', 1],
    ]);
  });
});
