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
});
