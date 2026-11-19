import { DataSource, EntityManager } from 'typeorm';
import { Workflow } from '../../src/entities';
import { ExecutionsService } from '../../src/executions/executions.service';
import { SchedulerService } from '../../src/scheduler/scheduler.service';
import { SystemDb } from '../../src/tenancy/system-db';
import { RunningApp, startApp } from '../helpers/app';
import { createTenant, openTestDataSource, truncateAll } from '../helpers/db';

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
    before?: (workflowId: string, call: number) => Promise<void>,
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
    const { calls, restore } = recordFirings();
    try {
      await scheduler.tick();
      const tenants = calls.map((c) => c.tenantId);
      expect(tenants).toContain(a);
      // Раунд тенанта — до 16 спроб постановки, а не 16 workflow з усіма їхніми спрацюваннями.
      expect(tenants.indexOf(b)).toBeLessThanOrEqual(16);

      // Відновлення посеред workflow і між сторінками не губить і не повторює спрацювань.
      const byWorkflow = new Map<string, number[]>();
      for (const c of calls)
        byWorkflow.set(c.workflowId, [
          ...(byWorkflow.get(c.workflowId) ?? []),
          c.at,
        ]);
      expect(byWorkflow.size).toBe(21);
      const perWorkflow = [...byWorkflow.values()];
      const expected = perWorkflow[0].length;
      expect(expected).toBeGreaterThanOrEqual(15);
      for (const times of perWorkflow) {
        expect(Math.abs(times.length - expected)).toBeLessThanOrEqual(1);
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
