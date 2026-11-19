import { DataSource } from 'typeorm';
import { SystemDb } from '../../src/tenancy/system-db';
import { createWorkflow } from '../helpers/db';
import { ExecutionsService } from '../../src/executions/executions.service';
import { SchedulerService } from '../../src/scheduler/scheduler.service';
import { RunningApp, startApp } from '../helpers/app';
import { createTenant, openTestDataSource, truncateAll } from '../helpers/db';

describe('scheduled tenant fairness', () => {
  let ds: DataSource;
  let app: RunningApp;
  beforeAll(async () => {
    ds = await openTestDataSource();
    await truncateAll(ds);
    app = await startApp();
    app.app.get(SchedulerService).onApplicationShutdown();
  });
  beforeEach(() => truncateAll(ds));
  afterAll(async () => {
    await app.close();
    await truncateAll(ds);
    await ds.destroy();
  });
  it('does not enqueue the same scheduled instant again after a later page read fails', async () => {
    const { tenant } = await createTenant(ds);
    const wf = await createWorkflow(ds, tenant.id);
    await ds.query('UPDATE workflows SET cron=$2 WHERE id=$1', [
      wf.id,
      '* * * * * *',
    ]);
    const system = app.app.get(SystemDb);
    const page = jest.spyOn(system, 'scheduledTenants');
    const tenants = Array.from({ length: 500 }, (_, i) => ({
      tenantId:
        i === 0
          ? tenant.id
          : '00000000-0000-4000-8000-' + String(i).padStart(12, '0'),
    }));
    page
      .mockResolvedValueOnce(tenants)
      .mockRejectedValueOnce(new Error('page unavailable'));
    const until = new Date(Date.now() + 2000);
    const scheduler = app.app.get(SchedulerService);
    try {
      await expect(scheduler.tick(until)).rejects.toThrow('page unavailable');
      const before = await ds.query<{ id: string }[]>(
        'SELECT id FROM executions WHERE "workflowId"=$1 ORDER BY id',
        [wf.id],
      );
      expect(before.length).toBeGreaterThan(0);
      await scheduler.tick(until);
      expect(
        await ds.query(
          'SELECT id FROM executions WHERE "workflowId"=$1 ORDER BY id',
          [wf.id],
        ),
      ).toEqual(before);
    } finally {
      page.mockRestore();
    }
  });
  it('reaches the small tenant before draining pages of schedules from its neighbor', async () => {
    const [a, b] = [
      (await createTenant(ds, 'first')).tenant.id,
      (await createTenant(ds, 'second')).tenant.id,
    ].sort();
    await ds.query(
      `INSERT INTO workflows(id,"tenantId",name,steps,cron)
      SELECT ('00000000-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid,
             CASE WHEN g=1201 THEN $2::uuid ELSE $1::uuid END, 'clock','[]','* * * * * *'
      FROM generate_series(1,1201) g`,
      [a, b],
    );
    const seen: string[] = [];
    const ids = new Set<string>();
    const fire = jest
      .spyOn(app.app.get(ExecutionsService), 'enqueueScheduled')
      .mockImplementation((wf) => {
        seen.push(wf.tenantId);
        ids.add(wf.id);
        return Promise.reject(new Error('stop after first occurrence'));
      });
    try {
      await app.app.get(SchedulerService).tick(new Date(Date.now() + 3000));
      expect(ids.size).toBe(1201);
      expect(seen).toHaveLength(1201);
      expect(seen).toContain(b);
      expect(seen.indexOf(b)).toBeLessThanOrEqual(32);
    } finally {
      fire.mockRestore();
    }
  });

  /** Два тенанти: `count` секундних розкладів у першого (за id) і один у другого. */
  async function neighbors(count: number): Promise<[string, string]> {
    const [a, b] = [
      (await createTenant(ds, 'busy')).tenant.id,
      (await createTenant(ds, 'small')).tenant.id,
    ].sort();
    await ds.query(
      `INSERT INTO workflows(id,"tenantId",name,steps,cron)
       SELECT ('00000000-0000-4000-9000-'||lpad(g::text,12,'0'))::uuid,
              CASE WHEN g > $3 THEN $2::uuid ELSE $1::uuid END, 'clock','[]','* * * * * *'
         FROM generate_series(1, $3 + 1) g`,
      [a, b, count],
    );
    return [a, b];
  }

  /** Успішні постановки (без запису в БД) у порядку спроб; `before` — перед кожною. */
  function recordFirings(before?: (workflowId: string) => Promise<void>): {
    calls: Array<{ tenantId: string; workflowId: string; at: number }>;
    restore: () => void;
  } {
    const calls: Array<{ tenantId: string; workflowId: string; at: number }> =
      [];
    const fire = jest
      .spyOn(app.app.get(ExecutionsService), 'enqueueScheduled')
      .mockImplementation(async (wf, scheduledAt) => {
        await before?.(wf.id);
        calls.push({
          tenantId: wf.tenantId,
          workflowId: wf.id,
          at: scheduledAt.getTime(),
        });
        return true;
      });
    return { calls, restore: () => fire.mockRestore() };
  }

  it('reaches the small tenant within one round budget even when every schedule of its neighbor fires many times', async () => {
    const [a, b] = await neighbors(20);
    const { calls, restore } = recordFirings();
    try {
      await app.app.get(SchedulerService).tick(new Date(Date.now() + 15_000));
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
      expect(expected).toBeGreaterThan(10);
      for (const times of perWorkflow) {
        expect(times).toHaveLength(expected);
        expect(times).toEqual([...times].sort((x, y) => x - y));
        expect(new Set(times).size).toBe(times.length);
      }
    } finally {
      restore();
    }
  });

  it('stops a schedule disabled between rounds of the same tick', async () => {
    const [a] = await neighbors(1);
    const [busy]: Array<{ id: string }> = await ds.query(
      'SELECT id FROM workflows WHERE "tenantId" = $1',
      [a],
    );
    let disabled = false;
    const { calls, restore } = recordFirings(async (workflowId) => {
      if (workflowId !== busy.id || disabled) return;
      disabled = true;
      await ds.query('UPDATE workflows SET enabled = false WHERE id = $1', [
        busy.id,
      ]);
    });
    try {
      // Вікно тіку — понад хвилину секундних спрацювань (попередні тести зсунули lastTick уперед).
      await app.app.get(SchedulerService).tick(new Date(Date.now() + 120_000));
      // Вимкнений workflow дограє лише свій поточний раунд (16 спроб), а не весь тік.
      expect(calls.filter((c) => c.workflowId === busy.id)).toHaveLength(16);
    } finally {
      restore();
    }
  });
});
