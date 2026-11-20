import { DataSource } from 'typeorm';
import {
  CronSchedule,
  InvalidScheduleError,
} from '../../src/scheduler/cron-schedule';
import { SchedulerMetrics } from '../../src/scheduler/scheduler.metrics';
import { SchedulerService } from '../../src/scheduler/scheduler.service';
import { RunningApp, startApp } from '../helpers/app';
import { createTenant, openTestDataSource, truncateAll } from '../helpers/db';
import { waitForBlocked } from '../helpers/transaction-barrier';
import { sleep } from '../helpers/queue';
import { dbNow, scheduledTimes, tenantCall } from '../helpers/schedule';

const GRACE_MS = 60_000; // SCHEDULER_MISFIRE_GRACE_MS за замовчуванням
const STEP_MS = 10_000; // розклад `*/10 * * * * *`

/**
 * Політика пропущених запусків (ТЗ 3.3.8): моменти, старші за SCHEDULER_MISFIRE_GRACE_MS на час
 * обробки, — пропуск простою. Простій імітує курсор розкладу, зсунутий на 5 хвилин назад.
 */
describe('missed scheduled runs', () => {
  let ds: DataSource;
  let app: RunningApp;
  let scheduler: SchedulerService;
  let apiKey: string;
  let tenantId: string;

  beforeAll(async () => {
    ds = await openTestDataSource();
    app = await startApp();
    scheduler = app.app.get(SchedulerService);
    scheduler.onApplicationShutdown();
  });
  beforeEach(async () => {
    await truncateAll(ds);
    ({
      apiKey,
      tenant: { id: tenantId },
    } = await createTenant(ds));
  });
  afterAll(async () => {
    await app.close();
    await truncateAll(ds);
    await ds.destroy();
  });

  /** Workflow через API, потім «простій»: курсор на `behindMs` назад (кратний кроку розкладу). */
  async function stalled(
    fields: Record<string, unknown>,
    behindMs: number,
  ): Promise<{ id: string; cursor: number }> {
    const res = await tenantCall(app, apiKey, 'POST', '/workflows', {
      name: 'missed',
      steps: [{ id: 'say', type: 'log', message: 'tick' }],
      cron: '*/10 * * * * *',
      ...fields,
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const now = (await dbNow(ds)).getTime();
    const cursor = Math.floor((now - behindMs) / STEP_MS) * STEP_MS;
    await ds.query(
      `UPDATE workflows SET "scheduleCursor" = $2, "nextFireAt" = now() WHERE id = $1`,
      [id, new Date(cursor)],
    );
    return { id, cursor };
  }

  it('anchors a re-enabled schedule after the update acquires the workflow lock', async () => {
    const { id } = await stalled({ enabled: false }, 1000);
    const holder = ds.createQueryRunner();
    await holder.startTransaction();
    let patch: Promise<Response> | undefined;
    try {
      await holder.query('SELECT id FROM workflows WHERE id=$1 FOR UPDATE', [
        id,
      ]);
      patch = tenantCall(app, apiKey, 'PATCH', `/workflows/${id}`, {
        enabled: true,
      });
      await waitForBlocked(ds, holder);
      const beforeRelease = await dbNow(ds);
      await holder.commitTransaction();
      const response = await patch;
      const state = (await response.json()) as {
        scheduleCursor: string;
        nextFireAt: string;
      };
      expect(response.status).toBe(200);
      expect(Date.parse(state.scheduleCursor)).toBeGreaterThanOrEqual(
        beforeRelease.getTime(),
      );
      expect(state.nextFireAt).toBe(state.scheduleCursor);
    } finally {
      if (holder.isTransactionActive) await holder.rollbackTransaction();
      await holder.release();
      await patch;
    }
  });

  it('clears all scheduler hints when a schedule is removed', async () => {
    const { id } = await stalled({}, 1000);
    await ds.query(
      `UPDATE workflows SET "scheduleError"='invalid', "scheduleBlockedSince"=now() WHERE id=$1`,
      [id],
    );
    const res = await tenantCall(app, apiKey, 'PATCH', `/workflows/${id}`, {
      cron: null,
    });
    expect(await res.json()).toMatchObject({
      cron: null,
      nextFireAt: null,
      scheduleBlockedSince: null,
      scheduleError: null,
    });
  });

  it('rejects invalid cron arity before updating the schedule', async () => {
    const { id } = await stalled({}, 1000);
    const state = () =>
      ds.query<unknown[]>(
        'SELECT cron, "scheduleCursor", "nextFireAt" FROM workflows WHERE id=$1',
        [id],
      );
    const before = await state();
    for (const fields of [1, 2, 3, 4, 7]) {
      const cron = Array<string>(fields).fill('*').join(' ');
      expect(
        (
          await tenantCall(app, apiKey, 'POST', '/workflows', {
            name: 'arity',
            steps: [{ id: 's', type: 'log', message: 's' }],
            cron,
          })
        ).status,
      ).toBe(400);
      expect(
        (await tenantCall(app, apiKey, 'PATCH', `/workflows/${id}`, { cron }))
          .status,
      ).toBe(400);
      expect(await state()).toEqual(before);
    }
    for (const cron of ['@hourly', '* * * * *', '* * * * * *'])
      expect(
        (await tenantCall(app, apiKey, 'PATCH', `/workflows/${id}`, { cron }))
          .status,
      ).toBe(200);
    await ds.query(
      `UPDATE workflows SET cron='* *', "nextFireAt"=now() WHERE id=$1`,
      [id],
    );
    await scheduler.tick();
    expect(
      await ds.query(
        'SELECT "nextFireAt", "scheduleError" FROM workflows WHERE id=$1',
        [id],
      ),
    ).toEqual([
      { nextFireAt: null, scheduleError: expect.any(String) as unknown },
    ]);
  });

  /** Моменти розкладу в (from, to]. */
  function moments(from: number, to: number): number[] {
    const out: number[] = [];
    for (
      let t = Math.floor(from / STEP_MS) * STEP_MS + STEP_MS;
      t <= to;
      t += STEP_MS
    )
      out.push(t);
    return out;
  }

  async function firingCount(outcome: string): Promise<number> {
    const { values } = await app.app.get(SchedulerMetrics).firings.get();
    return values.find((v) => v.labels.outcome === outcome)?.value ?? 0;
  }

  it('skip: drops every moment older than the grace window and keeps the recent ones', async () => {
    const { id, cursor } = await stalled({ missedRunPolicy: 'skip' }, 300_000);
    const skippedBefore = await firingCount('missed_skipped');
    const before = (await dbNow(ds)).getTime();
    await scheduler.tick();
    const after = (await dbNow(ds)).getTime();
    const times = await scheduledTimes(ds, id);
    // Нічого старшого за межу пропуску (межа — за часом БД під час обробки, між before і after).
    expect(times.filter((t) => t < before - GRACE_MS)).toEqual([]);
    // Вчасні моменти останньої хвилини — створені, кожен раз.
    expect(times).toEqual(
      expect.arrayContaining(moments(after - GRACE_MS, before)),
    );
    expect(new Set(times).size).toBe(times.length);
    expect(times.length).toBeLessThanOrEqual(GRACE_MS / STEP_MS + 1);
    expect(await firingCount('missed_skipped')).toBe(skippedBefore + 1);
    expect(cursor).toBeLessThan(before - GRACE_MS);
  });

  it('run_once: creates one run for the latest missed moment and then the recent ones', async () => {
    const { id, cursor } = await stalled(
      { missedRunPolicy: 'run_once' },
      300_000,
    );
    const before = (await dbNow(ds)).getTime();
    await scheduler.tick();
    const after = (await dbNow(ds)).getTime();
    const times = await scheduledTimes(ds, id);
    const old = times.filter((t) => t < after - GRACE_MS);
    // Рівно один запуск за весь пропуск — останній пропущений момент, не перший.
    expect(old).toHaveLength(1);
    expect(old[0]).toBeGreaterThanOrEqual(
      Math.floor((before - GRACE_MS) / STEP_MS) * STEP_MS - STEP_MS,
    );
    expect(old[0]).toBeGreaterThan(cursor + STEP_MS);
    expect(times).toEqual(
      expect.arrayContaining(moments(after - GRACE_MS, before)),
    );
    expect(new Set(times).size).toBe(times.length);
  });

  it('run_all: creates every missed moment, past the per-pass budget, in schedule order', async () => {
    const { id, cursor } = await stalled(
      { missedRunPolicy: 'run_all' },
      300_000,
    );
    const before = (await dbNow(ds)).getTime();
    await scheduler.tick();
    const times = await scheduledTimes(ds, id);
    // 30 моментів пропуску — більше за бюджет раунду тенанта (16): залишок не відкинуто.
    const expected = moments(cursor, before);
    expect(expected.length).toBeGreaterThanOrEqual(30);
    expect(times).toEqual(expect.arrayContaining(expected));
    expect(times.slice(0, expected.length)).toEqual(expected);
    expect(new Set(times).size).toBe(times.length);
  });

  it('run_all: resumes the remainder on the next tick after the pass was interrupted', async () => {
    const { id, cursor } = await stalled(
      { missedRunPolicy: 'run_all' },
      300_000,
    );
    // Тік перериває завершення процесу після кількох спрацювань; залишок — у курсорі БД.
    const ticking = scheduler.tick();
    await sleep(30);
    (scheduler as unknown as { stopping: boolean }).stopping = true;
    await ticking;
    (scheduler as unknown as { stopping: boolean }).stopping = false;
    const partial = await scheduledTimes(ds, id);
    const before = (await dbNow(ds)).getTime();
    expect(partial.length).toBeLessThan(moments(cursor, before).length);
    await scheduler.tick();
    const times = await scheduledTimes(ds, id);
    expect(times.slice(0, partial.length)).toEqual(partial);
    expect(times).toEqual(expect.arrayContaining(moments(cursor, before)));
    expect(new Set(times).size).toBe(times.length);
  });

  it('starts a changed schedule from the moment of the change and drops the backlog of the old one', async () => {
    const { id } = await stalled({ missedRunPolicy: 'run_all' }, 300_000);
    const res = await tenantCall(app, apiKey, 'PATCH', `/workflows/${id}`, {
      cron: '*/5 * * * * *',
    });
    expect(res.status).toBe(200);
    const changedAt = (await dbNow(ds)).getTime();
    await sleep(1_100);
    await scheduler.tick();
    expect(
      (await scheduledTimes(ds, id)).filter((t) => t <= changedAt - 1_000),
    ).toEqual([]);
  });

  it('keeps the progress when only the policy changes', async () => {
    const { id, cursor } = await stalled({ missedRunPolicy: 'skip' }, 300_000);
    const res = await tenantCall(app, apiKey, 'PATCH', `/workflows/${id}`, {
      missedRunPolicy: 'run_all',
    });
    expect(res.status).toBe(200);
    const before = (await dbNow(ds)).getTime();
    await scheduler.tick();
    expect(await scheduledTimes(ds, id)).toEqual(
      expect.arrayContaining(moments(cursor, before)),
    );
  });

  it('does not fire again for moments whose executions the history cleanup deleted', async () => {
    const { id, cursor } = await stalled(
      { missedRunPolicy: 'run_all' },
      60_000,
    );
    const before = (await dbNow(ds)).getTime();
    await scheduler.tick();
    const fired = await scheduledTimes(ds, id);
    expect(fired).toEqual(expect.arrayContaining(moments(cursor, before)));
    // Очищення історії (як purge_execution_history): виконання й задачі зникли.
    await ds.query('DELETE FROM jobs');
    await ds.query('DELETE FROM executions');
    await scheduler.tick();
    const again = await scheduledTimes(ds, id);
    expect(again.filter((t) => fired.includes(t))).toEqual([]);
  });

  it('keeps serving other schedules while a legacy schedule cannot be evaluated, and recovers after a fix', async () => {
    const good = await stalled({ missedRunPolicy: 'run_all' }, 30_000);
    const bad = await stalled({ missedRunPolicy: 'run_all' }, 30_000);
    // Рядок попередньої версії, яку API тепер не прийняв би.
    await ds.query(
      `UPDATE workflows SET timezone = 'Mars/Olympus' WHERE id = $1`,
      [bad.id],
    );
    const errors = async () =>
      (await app.app.get(SchedulerMetrics).errors.get()).values.find(
        (v) => v.labels.reason === 'invalid_schedule',
      )?.value ?? 0;
    const errorsBefore = await errors();
    await scheduler.tick();
    expect((await scheduledTimes(ds, good.id)).length).toBeGreaterThan(0);
    expect(await scheduledTimes(ds, bad.id)).toEqual([]);
    const [row]: Array<{ error: string | null; next: Date | null }> =
      await ds.query(
        'SELECT "scheduleError" AS error, "nextFireAt" AS next FROM workflows WHERE id = $1',
        [bad.id],
      );
    expect(row.error).toMatch(/timezone/);
    expect(row.next).toBeNull();
    // Наступний тік не повертається до несправного розкладу.
    await scheduler.tick();
    expect(await errors()).toBe(errorsBefore + 1);
    const fixed = await tenantCall(
      app,
      apiKey,
      'PATCH',
      `/workflows/${bad.id}`,
      {
        timezone: 'UTC',
      },
    );
    expect(fixed.status).toBe(200);
    expect(
      ((await fixed.json()) as { scheduleError: unknown }).scheduleError,
    ).toBeNull();
    await sleep(STEP_MS + 500);
    await scheduler.tick();
    expect((await scheduledTimes(ds, bad.id)).length).toBeGreaterThan(0);
  });

  it('keeps a firing when the moment after it cannot be computed', async () => {
    const { id } = await stalled({ missedRunPolicy: 'run_all' }, 20_000);
    // Генератор знаходить належний момент, а наступного за ним у межах горизонту немає.
    // Справжній метод — до підміни (дескриптор, а не посилання на метод).
    const original: unknown = Object.getOwnPropertyDescriptor(
      CronSchedule.prototype,
      'next',
    )?.value;
    const real = (schedule: CronSchedule, after: Date): Date =>
      Reflect.apply(original as (after: Date) => Date, schedule, [after]);
    let calls = 0;
    const spy = jest
      .spyOn(CronSchedule.prototype, 'next')
      .mockImplementation(function (this: CronSchedule, after: Date) {
        calls++;
        // parse() і пошук належного моменту — справжні; далі генератор «вичерпано».
        if (calls <= 2) return real(this, after);
        throw new InvalidScheduleError('schedule has no upcoming occurrence');
      });
    const errorsBefore =
      (await app.app.get(SchedulerMetrics).errors.get()).values.find(
        (v) => v.labels.reason === 'database',
      )?.value ?? 0;
    try {
      expect(await scheduler.tick()).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(await scheduledTimes(ds, id)).toHaveLength(1);
    const [row]: Array<{ next: Date | null; error: string | null }> =
      await ds.query(
        'SELECT "nextFireAt" AS next, "scheduleError" AS error FROM workflows WHERE id = $1',
        [id],
      );
    // Спрацювання збережено; розклад без майбутніх моментів далі не обробляється й позначений.
    expect(row.next).toBeNull();
    expect(row.error).toMatch(/no upcoming occurrence/);
    expect(
      (await app.app.get(SchedulerMetrics).errors.get()).values.find(
        (v) => v.labels.reason === 'database',
      )?.value ?? 0,
    ).toBe(errorsBefore);
  });

  it('rejects an unknown missed-run policy with 400', async () => {
    const res = await tenantCall(app, apiKey, 'POST', '/workflows', {
      name: 'w',
      steps: [{ id: 'say', type: 'log', message: 'x' }],
      cron: '0 * * * *',
      missedRunPolicy: 'run_some',
    });
    expect(res.status).toBe(400);
    expect(tenantId).toBeDefined();
  });
});
