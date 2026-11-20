import type { ConfigService } from '@nestjs/config';
import type { EntityManager } from 'typeorm';
import type { EnvironmentVariables } from '../../src/config/env.validation';
import type { MissedRunPolicy } from '../../src/entities';
import type { ExecutionsService } from '../../src/executions/executions.service';
import { CronSchedule } from '../../src/scheduler/cron-schedule';
import type { SchedulerMetrics } from '../../src/scheduler/scheduler.metrics';
import { SchedulerService } from '../../src/scheduler/scheduler.service';
import type { SystemDb } from '../../src/tenancy/system-db';
import type { TenantDb } from '../../src/tenancy/tenant-db';

/**
 * Межа допустимого запізнення (README 3.3.8): момент пропущений лише тоді, коли він строго
 * раніший за `now − SCHEDULER_MISFIRE_GRACE_MS`. Справжній SchedulerService з фіксованим часом БД:
 * рядок workflow і запис курсора підміняє EntityManager у пам'яті, тож межу можна поставити точно
 * на момент розкладу (у живій БД `clock_timestamp()` цього не дозволяє).
 */

type Attempt = { attempt: string; created: boolean };

interface Outcome {
  /** Моменти, для яких створено виконання, у порядку створення. */
  runs: number[];
  /** Курсор після останнього проходу. */
  cursor: number;
  /** Скільки разів спрацювала політика skip. */
  skips: number;
}

/** Проходи спрацювання одного workflow при незмінному часі БД — доки момент не стане майбутнім. */
async function tick(
  cron: string,
  timezone: string,
  policy: MissedRunPolicy,
  cursorMs: number,
  nowMs: number,
  graceMs: number,
): Promise<Outcome> {
  const state = { cursor: new Date(cursorMs), nextFireAt: null as Date | null };
  const runs: number[] = [];
  let skips = 0;
  const em = {
    query: (sql: string, params: unknown[]) => {
      if (sql.trimStart().startsWith('SELECT'))
        return Promise.resolve([
          {
            id: 'wf',
            tenantId: 't',
            cron,
            timezone,
            version: 1,
            revision: '1',
            missedRunPolicy: policy,
            scheduleCursor: state.cursor,
            nextFireAt: state.nextFireAt,
            scheduleBlockedSince: null,
            scheduleError: null,
            now: new Date(nowMs),
          },
        ]);
      if (sql.trimStart().startsWith('UPDATE workflows SET "scheduleCursor"')) {
        state.cursor = params[2] as Date;
        state.nextFireAt = params[3] as Date | null;
        return Promise.resolve([]);
      }
      return Promise.reject(new Error(`unexpected query: ${sql}`));
    },
    create: (_entity: unknown, value: object) => value,
  } as unknown as EntityManager;
  const executions = {
    enqueueScheduledIn: (_em: unknown, _wf: unknown, at: Date) => {
      runs.push(at.getTime());
      return Promise.resolve(true);
    },
  } as unknown as ExecutionsService;
  const config = {
    get: (name: string) => {
      if (name !== 'SCHEDULER_MISFIRE_GRACE_MS')
        throw new Error(`unexpected setting ${name}`);
      return graceMs;
    },
  } as unknown as ConfigService<EnvironmentVariables, true>;
  const metrics = {
    firings: { inc: () => undefined },
    lag: { observe: () => undefined },
  } as unknown as SchedulerMetrics;
  const service = new SchedulerService(
    {} as SystemDb,
    {} as TenantDb,
    executions,
    config,
    metrics,
  );
  const fireIn = (
    service as unknown as {
      fireIn(
        em: EntityManager,
        tenantId: string,
        workflowId: string,
        afterCommit: Array<() => void>,
      ): Promise<Attempt>;
    }
  ).fireIn.bind(service);
  for (let pass = 0; pass < 10_000; pass++) {
    const { attempt } = await fireIn(em, 't', 'wf', []);
    if (attempt === 'idle')
      return { runs, cursor: state.cursor.getTime(), skips };
    if (attempt === 'skipped') skips++;
    else if (attempt !== 'fired') throw new Error(`unexpected ${attempt}`);
  }
  throw new Error('the tick did not settle');
}

/** Усі моменти розкладу в (from, to]. */
function moments(
  cron: string,
  timezone: string,
  from: number,
  to: number,
): number[] {
  const schedule = CronSchedule.parse(cron, timezone, to);
  const out: number[] = [];
  for (let at = schedule.next(new Date(from)); at.getTime() <= to;) {
    out.push(at.getTime());
    at = schedule.next(at);
  }
  return out;
}

const iso = (s: string) => new Date(s).getTime();

describe('scheduler: the misfire grace edge', () => {
  // Сценарій ревʼю: секундний cron, межа рівно на 00:00:05, накопичені старі моменти.
  const cursor = iso('2026-01-01T00:00:00Z');
  const now = iso('2026-01-01T00:00:10Z');
  const grace = 5_000;
  const edge = now - grace;

  it('skip: the moment exactly on now − grace runs, older ones are dropped', async () => {
    const result = await tick('* * * * * *', 'UTC', 'skip', cursor, now, grace);
    expect(result.runs).toEqual(moments('* * * * * *', 'UTC', edge - 1, now));
    expect(result.runs[0]).toBe(edge);
    expect(result.skips).toBe(1);
    expect(result.cursor).toBe(now);
  });

  it('run_once: one run for the missed moments, then the edge moment on its own', async () => {
    const result = await tick(
      '* * * * * *',
      'UTC',
      'run_once',
      cursor,
      now,
      grace,
    );
    expect(result.runs).toEqual([
      edge - 1_000,
      ...moments('* * * * * *', 'UTC', edge - 1, now),
    ]);
    expect(result.cursor).toBe(now);
  });

  it('run_all: every moment runs once, the edge included', async () => {
    const result = await tick(
      '* * * * * *',
      'UTC',
      'run_all',
      cursor,
      now,
      grace,
    );
    expect(result.runs).toEqual(moments('* * * * * *', 'UTC', cursor, now));
  });
});

describe('scheduler: no on-time moment is lost and none runs twice', () => {
  // Розклад, пояс, вікно спостереження й допуски: вікно охоплює кілька десятків моментів, щоб
  // run_all лишався швидким, а допуск — від меншого за крок розкладу до кратного йому.
  const cases: Array<[string, string, number, number[]]> = [
    ['* * * * * *', 'UTC', 60_000, [1_000, 5_000, 30_000]],
    ['*/7 * * * * *', 'UTC', 300_000, [1_000, 7_000, 60_000]],
    ['* * * * *', 'UTC', 1_200_000, [1_000, 60_000, 300_000]],
    ['*/5 * * * *', 'Europe/Kyiv', 3_600_000, [1_000, 300_000, 1_200_000]],
    // Осінній перехід Нью-Йорка: 2026-11-01 02:00 EDT → 01:00 EST (06:00Z), година повторюється.
    [
      '*/10 1 * * *',
      'America/New_York',
      3 * 3_600_000,
      [1_000, 600_000, 3_600_000],
    ],
  ];
  const policies: MissedRunPolicy[] = ['skip', 'run_once', 'run_all'];
  // Межа рівно на моменті, на мілісекунду раніше й пізніше, і посередині між моментами.
  const offsets = [0, -1, 1, 437];
  const base = iso('2026-11-01T04:00:00Z');

  it.each(cases)('%s in %s', async (cron, timezone, windowMs, graces) => {
    const all = moments(cron, timezone, base, base + windowMs);
    let checked = 0;
    // Кілька положень межі відносно різних моментів розкладу.
    for (const anchor of [all[1], all[Math.floor(all.length / 2)], all.at(-2)!])
      for (const offset of offsets)
        for (const graceMs of graces)
          for (const policy of policies) {
            const edge = anchor + offset;
            const now = edge + graceMs;
            const due = moments(cron, timezone, base, now);
            const onTime = due.filter((m) => m >= edge);
            const missed = due.filter((m) => m < edge);
            const { runs, cursor } = await tick(
              cron,
              timezone,
              policy,
              base,
              now,
              graceMs,
            );
            const context = { cron, timezone, policy, edge, graceMs };
            // Кожен вчасний момент — рівно одне власне виконання, у порядку розкладу.
            expect({
              ...context,
              onTime: runs.filter((r) => r >= edge),
            }).toEqual({ ...context, onTime });
            const early = runs.filter((r) => r < edge);
            if (policy === 'run_all') expect(early).toEqual(missed);
            if (policy === 'run_once')
              expect(early).toEqual(missed.length ? [missed.at(-1)] : []);
            if (policy === 'skip') expect(early).toEqual([]);
            // Курсор — останній оброблений момент; далі лише майбутні.
            expect(cursor).toBe(due.length ? due.at(-1) : base);
            checked++;
          }
    expect(checked).toBe(3 * offsets.length * 3 * policies.length);
  });
});
