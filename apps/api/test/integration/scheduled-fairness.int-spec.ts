import { EnvironmentVariables } from '../../src/config/env.validation';
import { SchedulerMetrics } from '../../src/scheduler/scheduler.metrics';
import { TenantDb } from '../../src/tenancy/tenant-db';

import { ConfigService } from '@nestjs/config';
import { waitFor } from '../helpers/queue';

import { DataSource, EntityManager } from 'typeorm';
import { Workflow } from '../../src/entities';
import { ExecutionsService } from '../../src/executions/executions.service';
import { SchedulerService } from '../../src/scheduler/scheduler.service';
import { SystemDb } from '../../src/tenancy/system-db';
import { RunningApp, startApp } from '../helpers/app';
import { createTenant, openTestDataSource, truncateAll } from '../helpers/db';
import { dbNow, wholeSeconds } from '../helpers/schedule';

/**
 * Справедливість планувальника між тенантами (README 3.3.5, 3.3.8): тенант із тисячами розкладів
 * чи довгим пропуском не відсуває інших, а обхід після збою не губить і не повторює моментів.
 * Моменти «в минулому» задає курсор розкладу, зсунутий назад, — так само, як після простою.
 */
describe('scheduled tenant fairness', () => {
  let ds: DataSource;
  let app: RunningApp;
  let scheduler: SchedulerService;
  beforeAll(async () => {
    ds = await openTestDataSource();
    await truncateAll(ds);
    app = await startApp();
    scheduler = app.app.get(SchedulerService);
    scheduler.onApplicationShutdown();
  });
  beforeEach(() => truncateAll(ds));
  afterAll(async () => {
    await app.close();
    await truncateAll(ds);
    await ds.destroy();
  });

  /**
   * `count` секундних розкладів тенанта `tenantId` з курсором `behindMs` тому (політика
   * run_all: кожен момент пропуску — окреме спрацювання). Ідентифікатори — з префіксом `prefix`.
   */
  async function schedules(
    tenantId: string,
    count: number,
    behindMs: number,
    prefix: string,
  ): Promise<void> {
    await ds.query(
      `INSERT INTO workflows(id,"tenantId",name,steps,cron,"missedRunPolicy","scheduleCursor","nextFireAt")
       SELECT ($4 || lpad(g::text,12,'0'))::uuid, $1, 'clock', '[]', '* * * * * *', 'run_all',
              date_trunc('second', now()) - make_interval(secs => $3 / 1000.0), now() - interval '1 second'
         FROM generate_series(1, $2) g`,
      [tenantId, count, behindMs, prefix],
    );
    await ds.query(
      `INSERT INTO workflow_versions("workflowId","tenantId",version,steps)
       SELECT id, "tenantId", version, steps FROM workflows WHERE "tenantId" = $1`,
      [tenantId],
    );
  }

  /** Спроби постановки (без запису виконань) у порядку; `before` — перед кожною. */
  function recordFirings(
    before?: (workflowId: string, call: number) => Promise<void> | void,
    result: () => Promise<boolean> = () => Promise.resolve(true),
  ): {
    calls: Array<{ tenantId: string; workflowId: string; at: number }>;
    restore: () => void;
  } {
    const calls: Array<{ tenantId: string; workflowId: string; at: number }> =
      [];
    const fire = jest
      .spyOn(app.app.get(ExecutionsService), 'enqueueScheduledIn')
      .mockImplementation(
        async (_em: EntityManager, wf: Workflow, scheduledAt: Date) => {
          await before?.(wf.id, calls.length);
          calls.push({
            tenantId: wf.tenantId,
            workflowId: wf.id,
            at: scheduledAt.getTime(),
          });
          return result();
        },
      );
    return { calls, restore: () => fire.mockRestore() };
  }

  it('does not enqueue the same scheduled instant again after a later page read fails', async () => {
    const { tenant } = await createTenant(ds);
    await schedules(tenant.id, 1, 3_000, '00000000-0000-4000-8000-');
    const [wf]: Array<{ id: string }> = await ds.query(
      'SELECT id FROM workflows',
    );
    const system = app.app.get(SystemDb);
    const page = jest.spyOn(system, 'dueScheduleTenants');
    const tenants = Array.from({ length: 500 }, (_, i) => ({
      tenantId:
        i === 0
          ? tenant.id
          : '00000000-0000-4000-8000-' + String(i).padStart(12, '0'),
    }));
    page
      .mockResolvedValueOnce(tenants)
      .mockRejectedValueOnce(new Error('page unavailable'));
    try {
      await expect(scheduler.tick()).rejects.toThrow('page unavailable');
      const before = await ds.query<{ at: Date }[]>(
        'SELECT "scheduledAt" AS at FROM executions WHERE "workflowId"=$1 ORDER BY 1',
        [wf.id],
      );
      expect(before.length).toBeGreaterThan(0);
      await scheduler.tick();
      const after = await ds.query<{ at: Date }[]>(
        'SELECT "scheduledAt" AS at FROM executions WHERE "workflowId"=$1 ORDER BY 1',
        [wf.id],
      );
      // Ті самі моменти — без дублів — і далі, без пропуску.
      expect(after.slice(0, before.length)).toEqual(before);
      const times = after.map((r) => r.at.getTime());
      for (let i = 1; i < times.length; i++)
        expect(times[i] - times[i - 1]).toBe(1_000);
    } finally {
      page.mockRestore();
    }
  });

  it('reaches the small tenant before draining pages of schedules from its neighbor', async () => {
    const [a, b] = [
      (await createTenant(ds, 'first')).tenant.id,
      (await createTenant(ds, 'second')).tenant.id,
    ].sort();
    await schedules(a, 1200, 2_000, '00000000-0000-4000-8000-');
    await schedules(b, 1, 2_000, '00000000-0000-4000-9000-');
    const seen: string[] = [];
    const ids = new Set<string>();
    // Помилка БД саме цього спрацювання: обхід іде до наступного workflow.
    const fire = jest
      .spyOn(app.app.get(ExecutionsService), 'enqueueScheduledIn')
      .mockImplementation((_em, wf) => {
        seen.push(wf.tenantId);
        ids.add(wf.id);
        return Promise.reject(
          Object.assign(new Error('stop after the first occurrence'), {
            code: '40001',
          }),
        );
      });
    try {
      await scheduler.tick();
      expect(ids.size).toBe(1201);
      expect(seen).toHaveLength(1201);
      expect(seen.indexOf(b)).toBeGreaterThanOrEqual(0);
      expect(seen.indexOf(b)).toBeLessThanOrEqual(32);
    } finally {
      fire.mockRestore();
    }
  });

  it('reaches the small tenant within one round budget even when every schedule of its neighbor fires many times', async () => {
    const [a, b] = [
      (await createTenant(ds, 'busy')).tenant.id,
      (await createTenant(ds, 'small')).tenant.id,
    ].sort();
    await schedules(a, 20, 15_000, '00000000-0000-4000-9000-');
    await schedules(b, 1, 15_000, '00000000-0000-4000-a000-');
    const [{ cursor }]: Array<{ cursor: Date }> = await ds.query(
      'SELECT max("scheduleCursor") AS cursor FROM workflows',
    );
    const { calls, restore } = recordFirings();
    try {
      const before = await dbNow(ds);
      await scheduler.tick();
      const tenants = calls.map((c) => c.tenantId);
      expect(tenants).toContain(a);
      // Раунд тенанта — до 16 спроб постановки, а не 16 workflow з усіма їхніми спрацюваннями.
      expect(tenants.indexOf(b)).toBeLessThanOrEqual(16);

      // Відновлення посеред workflow і між сторінками не губить і не повторює спрацювань. Кожен
      // розклад має всі моменти від курсора до початку тіку; workflow, оброблені пізніше, бачать
      // пізніший час БД і можуть мати ще кілька моментів, тож однакової кількості не вимагаємо.
      const byWorkflow = new Map<string, number[]>();
      for (const c of calls)
        byWorkflow.set(c.workflowId, [
          ...(byWorkflow.get(c.workflowId) ?? []),
          c.at,
        ]);
      expect(byWorkflow.size).toBe(21);
      const due = wholeSeconds(cursor, before);
      expect(due.length).toBeGreaterThanOrEqual(15);
      for (const times of byWorkflow.values()) {
        expect(times.slice(0, due.length)).toEqual(due);
        expect(times).toEqual([...times].sort((x, y) => x - y));
        expect(new Set(times).size).toBe(times.length);
        for (let i = 1; i < times.length; i++)
          expect(times[i] - times[i - 1]).toBe(1_000);
      }
    } finally {
      restore();
    }
  });

  it('serves the small tenant every round while a neighbor catches up a long gap', async () => {
    const [a, b] = [
      (await createTenant(ds, 'behind')).tenant.id,
      (await createTenant(ds, 'small')).tenant.id,
    ].sort();
    // Десять хвилин секундного розкладу: 600 моментів, понад 37 раундів одного тенанта.
    await schedules(a, 1, 600_000, '00000000-0000-4000-9000-');
    await schedules(b, 1, 5_000, '00000000-0000-4000-a000-');
    const { calls, restore } = recordFirings();
    try {
      await scheduler.tick();
      const tenants = calls.map((c) => c.tenantId);
      // Малий тенант отримав усі свої моменти в перших раундах, не чекаючи на 600 моментів сусіда.
      const lastSmall = tenants.lastIndexOf(b);
      expect(tenants.filter((t) => t === b).length).toBeGreaterThanOrEqual(5);
      expect(lastSmall).toBeLessThan(16 * 8);
      // Увесь пропуск сусіда — кожен момент рівно раз, без обрізання межею проходу.
      const behind = calls.filter((c) => c.tenantId === a).map((c) => c.at);
      expect(behind.length).toBeGreaterThanOrEqual(600);
      expect(new Set(behind).size).toBe(behind.length);
      for (let i = 1; i < behind.length; i++)
        expect(behind[i] - behind[i - 1]).toBe(1_000);
    } finally {
      restore();
    }
  });

  it.each(['new', 'existing'])(
    'serves the first due moment of a %s tenant during live catch-up',
    async (kind) => {
      const live = new SchedulerService(
        app.app.get(SystemDb),
        app.app.get(TenantDb),
        app.app.get(ExecutionsService),
        new ConfigService<EnvironmentVariables, true>({
          SCHEDULER_TICK_MS: 100,
          SCHEDULER_MISFIRE_GRACE_MS: 1000,
        }),
        app.app.get(SchedulerMetrics),
      );
      const a = (await createTenant(ds, 'busy')).tenant.id;
      await schedules(a, 1, 1_600_000, '00000000-0000-4000-9000-');
      async function small() {
        const b = (await createTenant(ds, 'small')).tenant.id;
        const [wf] = await ds.query<Array<{ id: string; due: Date }>>(
          `WITH t AS (SELECT date_trunc('second',clock_timestamp())+interval '2 seconds' AS due),
           w AS (INSERT INTO workflows ("tenantId",name,steps,cron,"missedRunPolicy","scheduleCursor","nextFireAt")
            SELECT $1,'small','[]','* * * * * *','skip',due-interval '1 second',due FROM t RETURNING *),
           v AS (INSERT INTO workflow_versions ("tenantId","workflowId",version,steps) SELECT "tenantId",id,version,steps FROM w)
           SELECT id,"nextFireAt" AS due FROM w`,
          [b],
        );
        return wf;
      }
      let b = kind === 'existing' ? await small() : undefined;
      const environment = jest.replaceProperty(process, 'env', {
        ...process.env,
        SCHEDULER_TICK_MS: '100',
        SCHEDULER_MISFIRE_GRACE_MS: '1000',
      });
      live.onApplicationBootstrap();
      try {
        await waitFor(
          'first completed round',
          async () =>
            (
              await ds.query<Array<{ n: number }>>(
                'SELECT count(*)::int n FROM executions WHERE "tenantId"=$1',
                [a],
              )
            )[0].n >= 16,
        );
        b ??= await small();
        const { id, due } = b;
        await waitFor(
          'small tenant firing',
          async () =>
            (
              await ds.query<unknown[]>(
                'SELECT 1 FROM executions WHERE "workflowId"=$1 LIMIT 1',
                [id],
              )
            ).length > 0,
          { timeoutMs: 45000 },
        );
        const [row] = await ds.query<
          Array<{ first: Date; passed: number; before: number }>
        >(
          `WITH b AS (SELECT "scheduledAt", "createdAt" FROM executions WHERE "workflowId"=$2 ORDER BY "scheduledAt" LIMIT 1)
         SELECT b."scheduledAt" AS first, count(a.id)::int AS before,
          count(a.id) FILTER (WHERE a."createdAt">=$3)::int AS passed
         FROM b LEFT JOIN executions a ON a."tenantId"=$1 AND a."createdAt"<b."createdAt"
         GROUP BY b."scheduledAt"`,
          [a, id, due],
        );
        expect(row.first).toEqual(due);
        expect(row.before).toBeLessThan(1600);
        expect(row.passed).toBeLessThanOrEqual(16);
        live.onApplicationShutdown();
        await live.tick();
        const [all] = await ds.query<
          Array<{ n: number; distinct: number; span: number }>
        >(
          `SELECT count(*)::int n,count(DISTINCT "scheduledAt")::int distinct,
          extract(epoch FROM max("scheduledAt")-min("scheduledAt"))::int+1 span
          FROM executions WHERE "tenantId"=$1`,
          [a],
        );
        expect(all.n).toBeGreaterThanOrEqual(1600);
        expect(all).toMatchObject({ distinct: all.n, span: all.n });
      } finally {
        await live.beforeApplicationShutdown();
        environment.restore();
      }
    },
    90000,
  );

  it('retries a failed tenant on a new tick while still discovering other tenants between rounds', async () => {
    const a = (await createTenant(ds, 'catch-up')).tenant.id;
    const b = (await createTenant(ds, 'failed')).tenant.id;
    await schedules(a, 1, 45_000, '00000000-0000-4000-9000-');
    await schedules(b, 1, 1000, '00000000-0000-4000-a000-');
    let failures = 0;
    const log = recordFirings((id) => {
      if (id.startsWith('00000000-0000-4000-a000-')) {
        failures++;
        throw new Error('scheduled enqueue failed');
      }
    });
    try {
      await scheduler.tick();
      expect(failures).toBe(1);
      await scheduler.tick();
      expect(failures).toBe(2);
    } finally {
      log.restore();
    }
  });

  it('stops a schedule disabled between rounds of the same tick', async () => {
    const [a, b] = [
      (await createTenant(ds, 'busy')).tenant.id,
      (await createTenant(ds, 'small')).tenant.id,
    ].sort();
    await schedules(a, 1, 40_000, '00000000-0000-4000-9000-');
    await schedules(b, 1, 2_000, '00000000-0000-4000-a000-');
    const [busy]: Array<{ id: string }> = await ds.query(
      'SELECT id FROM workflows WHERE "tenantId" = $1',
      [a],
    );
    let disabled = false;
    const { calls, restore } = recordFirings(async (workflowId) => {
      // Хід малого тенанта — між раундами сусіда: його рядок у цей момент не заблоковано.
      if (workflowId === busy.id || disabled) return;
      disabled = true;
      await ds.query('UPDATE workflows SET enabled = false WHERE id = $1', [
        busy.id,
      ]);
    });
    try {
      await scheduler.tick();
      // Вимкнений workflow дограє лише свій поточний раунд (16 спроб), а не весь пропуск.
      expect(calls.filter((c) => c.workflowId === busy.id)).toHaveLength(16);
    } finally {
      restore();
    }
  });
});
