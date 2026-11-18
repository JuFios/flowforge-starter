import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { Execution, Job, StepRun } from '../../src/entities';
import { RunningApp, startApp } from '../helpers/app';
import { createTenant, openTestDataSource, truncateAll } from '../helpers/db';
import { api, sleep, startWorker, waitFor } from '../helpers/queue';

/**
 * Падіння посеред зміни кількох таблиць імітує тригер БД: перша спроба позначити задачу
 * завершеною обривається помилкою (як обрив з'єднання чи падіння процесу на цьому записі).
 */
describe('finishing an execution is atomic', () => {
  let ds: DataSource;
  let apiApp: RunningApp;
  let worker: RunningApp | undefined;

  beforeAll(async () => {
    ds = await openTestDataSource();
    apiApp = await startApp(AppModule);
    await ds.query(`CREATE SEQUENCE IF NOT EXISTS test_fail_once`);
    await ds.query(`
      CREATE OR REPLACE FUNCTION test_fail_first_done() RETURNS trigger AS $$
      BEGIN
        IF NEW.status = 'done' AND nextval('test_fail_once') = 1 THEN
          RAISE EXCEPTION 'simulated crash while finishing the job';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql
      -- Тригер спрацьовує в транзакції воркера (роль без прав на службову послідовність тесту).
      SECURITY DEFINER SET search_path = pg_catalog, public`);
    await ds.query(`
      CREATE TRIGGER test_fail_first_done BEFORE UPDATE ON jobs
      FOR EACH ROW EXECUTE FUNCTION test_fail_first_done()`);
  });

  beforeEach(() => truncateAll(ds));

  afterEach(async () => {
    await worker?.close();
    worker = undefined;
  });

  afterAll(async () => {
    await ds.query(`DROP TRIGGER IF EXISTS test_fail_first_done ON jobs`);
    await ds.query(`DROP FUNCTION IF EXISTS test_fail_first_done()`);
    await ds.query(`DROP SEQUENCE IF EXISTS test_fail_once`);
    await apiApp.close();
    await ds.destroy();
  });

  it('never shows a succeeded execution whose job is not done, and does not repeat its steps', async () => {
    const { apiKey } = await createTenant(ds);
    const wf = await api<{ id: string }>(
      apiApp.baseUrl,
      apiKey,
      'POST',
      '/workflows',
      { name: 'atomic', steps: [{ id: 'say', type: 'log', message: 'hi' }] },
    );
    const run = await api<{ id: string }>(
      apiApp.baseUrl,
      apiKey,
      'POST',
      `/workflows/${wf.body.id}/run`,
      {},
    );
    const id = run.body.id;
    await ds.getRepository(Job).update({ executionId: id }, { maxAttempts: 1 });

    // Спостерігач фіксує кожен проміжний стан пари execution/job.
    const inconsistent: string[] = [];
    let watching = true;
    const watcher = (async () => {
      while (watching) {
        const [row]: Array<{ execution: string; job: string }> = await ds.query(
          `SELECT e.status AS execution, j.status AS job
             FROM executions e JOIN jobs j ON j."executionId" = e.id WHERE e.id = $1`,
          [id],
        );
        if (row.execution === 'succeeded' && row.job !== 'done')
          inconsistent.push(`${row.execution}/${row.job}`);
        await sleep(5);
      }
    })();

    worker = await startWorker(1);
    try {
      await waitFor(
        'the execution and its job to finish',
        async () => {
          const [row]: Array<{ execution: string; job: string }> =
            await ds.query(
              `SELECT e.status AS execution, j.status AS job
                 FROM executions e JOIN jobs j ON j."executionId" = e.id WHERE e.id = $1`,
              [id],
            );
          return row.execution === 'succeeded' && row.job === 'done';
        },
        { timeoutMs: 20_000 },
      );
    } finally {
      watching = false;
      await watcher;
    }

    expect(inconsistent).toEqual([]);
    expect(
      (await ds.getRepository(Execution).findOneByOrFail({ id })).status,
    ).toBe('succeeded');
    const steps = await ds.getRepository(StepRun).findBy({ executionId: id });
    expect(steps.map((s) => [s.stepId, s.status, s.attempts])).toEqual([
      ['say', 'succeeded', 1],
    ]);
  });
});
