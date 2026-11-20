import { DataSource } from 'typeorm';
import { RunningApp, startApp } from '../helpers/app';
import { createTenant, openTestDataSource, truncateAll } from '../helpers/db';
import { sleep } from '../helpers/queue';
import {
  createScheduledWorkflow,
  dbNow,
  scheduledTimes,
  stopSchedulerTimer,
} from '../helpers/schedule';

/** Година моменту `at` у таймзоні `timeZone` (0–23). */
function hourIn(timeZone: string, at: Date): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(at),
  );
}

/**
 * Розклад обчислюється в таймзоні workflow (ТЗ 3.3.8), а не в таймзоні процесу планувальника.
 */
describe('scheduler timezone', () => {
  let ds: DataSource;
  let app: RunningApp;

  beforeAll(async () => {
    ds = await openTestDataSource();
    await truncateAll(ds);
    app = await startApp();
  });
  afterAll(async () => {
    await app.close();
    await truncateAll(ds);
    await ds.destroy();
  });

  it("fires at the hour of the workflow's timezone, not of the scheduler process", async () => {
    const scheduler = stopSchedulerTimer(app);
    // Не на межі години: усе вікно тесту — в одній годині.
    while (new Date().getMinutes() === 59 && new Date().getSeconds() >= 50)
      await sleep(1_000);
    const now = new Date();
    const processHour = now.getHours();
    const zone = ['Asia/Tokyo', 'America/New_York', 'Asia/Kolkata'].find(
      (z) => hourIn(z, now) !== processHour,
    ) as string;
    const hour = hourIn(zone, now);
    const { apiKey } = await createTenant(ds);
    // Щосекунди, але лише в поточну годину таймзони workflow.
    const wf = await createScheduledWorkflow(app, ds, apiKey, {
      cron: `* * ${hour} * * *`,
      timezone: zone,
    });
    await sleep(2_200);
    const before = await dbNow(ds);
    await scheduler.tick();
    const times = await scheduledTimes(ds, wf.id);
    expect(times.length).toBeGreaterThanOrEqual(1);
    expect(times.filter((t) => t <= before.getTime()).length).toBeGreaterThan(
      0,
    );
    for (const t of times) expect(hourIn(zone, new Date(t))).toBe(hour);
  });
});
