import { DataSource } from 'typeorm';
import { SchedulerService } from '../../src/scheduler/scheduler.service';
import { RunningApp, startApp } from '../helpers/app';
import { createTenant, openTestDataSource, truncateAll } from '../helpers/db';
import { sleep } from '../helpers/queue';
import {
  createScheduledWorkflow,
  dbNow,
  scheduledTimes,
  stopSchedulerTimer,
  wholeSeconds,
} from '../helpers/schedule';

/**
 * Прогрес планувальника (ТЗ 3.3.8): кожен момент розкладу після створення workflow обробляється
 * рівно один раз — і тоді, коли процес планувальника перезапустився.
 */
describe('scheduler progress', () => {
  let ds: DataSource;
  let apps: RunningApp[] = [];

  /** Інстанс API з планувальником, чий тік викликає тест. */
  async function scheduler(): Promise<{
    app: RunningApp;
    scheduler: SchedulerService;
  }> {
    const app = await startApp();
    apps.push(app);
    return { app, scheduler: stopSchedulerTimer(app) };
  }

  beforeAll(async () => {
    ds = await openTestDataSource();
  });
  beforeEach(() => truncateAll(ds));
  afterEach(async () => {
    for (const app of apps) await app.close();
    apps = [];
  });
  afterAll(async () => {
    await truncateAll(ds);
    await ds.destroy();
  });

  it('creates every firing that fell due while the scheduler was restarting', async () => {
    const { apiKey } = await createTenant(ds);
    const first = await scheduler();
    const wf = await createScheduledWorkflow(first.app, ds, apiKey, {
      cron: '* * * * * *',
    });
    // Планувальник зупиняється до першого тіку: усі спрацювання вікна припадають на простій.
    await first.app.close();
    apps = [];
    await sleep(2_500);
    const second = await scheduler();
    const before = await dbNow(ds);
    await second.scheduler.tick();
    const times = await scheduledTimes(ds, wf.id);
    expect(times).toEqual(
      expect.arrayContaining(wholeSeconds(wf.createdAt, before)),
    );
    expect(new Set(times).size).toBe(times.length);
  });

  describe('after a failed enqueue', () => {
    beforeAll(async () => {
      await ds.query(
        'CREATE TABLE IF NOT EXISTS test_block_executions (x int)',
      );
      await ds.query(`
        CREATE OR REPLACE FUNCTION test_block_executions() RETURNS trigger AS $$
        BEGIN
          IF EXISTS (SELECT FROM public.test_block_executions) THEN
            RAISE EXCEPTION 'simulated database failure while creating an execution';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql
        -- Тригер спрацьовує в транзакції ролі API, якій таблиця тесту не належить.
        SECURITY DEFINER SET search_path = pg_catalog, public`);
      await ds.query(
        'REVOKE ALL ON FUNCTION test_block_executions() FROM PUBLIC',
      );
      await ds.query(`
        CREATE TRIGGER test_block_executions BEFORE INSERT ON executions
        FOR EACH ROW EXECUTE FUNCTION test_block_executions()`);
    });
    afterAll(async () => {
      await ds.query(
        'DROP TRIGGER IF EXISTS test_block_executions ON executions',
      );
      await ds.query('DROP FUNCTION IF EXISTS test_block_executions()');
      await ds.query('DROP TABLE IF EXISTS test_block_executions');
    });

    it('creates the firings of a tick whose enqueue failed on the next tick', async () => {
      const { apiKey } = await createTenant(ds);
      const { app, scheduler: s } = await scheduler();
      const wf = await createScheduledWorkflow(app, ds, apiKey, {
        cron: '* * * * * *',
      });
      await ds.query('INSERT INTO test_block_executions VALUES (1)');
      await sleep(2_200);
      const failed = await dbNow(ds);
      await s.tick();
      expect(await scheduledTimes(ds, wf.id)).toEqual([]);
      await ds.query('DELETE FROM test_block_executions');
      await s.tick();
      const times = await scheduledTimes(ds, wf.id);
      // Спрацювання, які мав створити тік із помилкою, не загубились.
      expect(times).toEqual(
        expect.arrayContaining(wholeSeconds(wf.createdAt, failed)),
      );
      expect(new Set(times).size).toBe(times.length);
    });
  });
});
