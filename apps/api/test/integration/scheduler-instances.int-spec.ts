import { DataSource } from 'typeorm';
import { SchedulerService } from '../../src/scheduler/scheduler.service';
import { RunningApp, startApp } from '../helpers/app';
import { createTenant, openTestDataSource, truncateAll } from '../helpers/db';
import { waitFor } from '../helpers/queue';
import { dbNow, scheduledTimes } from '../helpers/schedule';

/**
 * Кілька інстансів планувальника (ТЗ 3.3.8, 6): кожен належний момент — рівно одне виконання.
 * Перевіряється і відсутність зайвого (дубля), і наявність потрібного (жоден момент не загублено),
 * також після обриву з'єднання посеред проходу й після невідомого результату COMMIT.
 */
describe('scheduler instances', () => {
  let ds: DataSource;
  let apps: RunningApp[] = [];

  async function instance(): Promise<SchedulerService> {
    const app = await startApp();
    apps.push(app);
    const scheduler = app.app.get(SchedulerService);
    scheduler.onApplicationShutdown();
    return scheduler;
  }

  /** Розклад `cron` з курсором `behindMs` тому (run_all) і його першою версією. */
  async function schedule(
    tenantId: string,
    cron: string,
    behindMs: number,
    count = 1,
  ): Promise<string[]> {
    const rows: Array<{ id: string }> = await ds.query(
      `INSERT INTO workflows("tenantId",name,steps,cron,"missedRunPolicy","scheduleCursor","nextFireAt")
       SELECT $1, 'clock', '[]', $2, 'run_all',
              date_trunc('second', now()) - make_interval(secs => $3 / 1000.0), now() - interval '1 second'
         FROM generate_series(1, $4)
       RETURNING id`,
      [tenantId, cron, behindMs, count],
    );
    await ds.query(
      `INSERT INTO workflow_versions("workflowId","tenantId",version,steps)
       SELECT id, "tenantId", version, steps FROM workflows WHERE "tenantId" = $1`,
      [tenantId],
    );
    return rows.map((r) => r.id);
  }

  /** Очікувані моменти розкладу з кроком stepMs у (cursor, until]. */
  async function expectedMoments(
    workflowId: string,
    stepMs: number,
    until: Date,
  ): Promise<number[]> {
    const [row]: Array<{ cursor: Date }> = await ds.query(
      `SELECT "scheduleCursor" AS cursor FROM workflows WHERE id = $1`,
      [workflowId],
    );
    const out: number[] = [];
    for (
      let t = Math.floor(row.cursor.getTime() / stepMs) * stepMs + stepMs;
      t <= until.getTime();
      t += stepMs
    )
      out.push(t);
    return out;
  }

  beforeAll(async () => {
    ds = await openTestDataSource();
  });
  beforeEach(() => truncateAll(ds));
  afterEach(async () => {
    for (const app of apps) await app.close();
    apps = [];
    await ds.query('DROP TRIGGER IF EXISTS test_scheduler_hook ON executions');
    await ds.query('DROP FUNCTION IF EXISTS test_scheduler_hook()');
    await ds.query('DROP SEQUENCE IF EXISTS test_scheduler_hook');
  });
  afterAll(async () => {
    await truncateAll(ds);
    await ds.destroy();
  });

  /**
   * Тестовий тригер на вставку виконання: `action` — SQL, що виконується на N-й вставці (лічильник
   * — послідовність тесту). Тригер виконується в транзакції планувальника, під роллю API.
   */
  async function hook(atInsert: number, action: string): Promise<void> {
    // Послідовність, а не таблиця: лічильник не відкочується разом з обірваною транзакцією.
    await ds.query('CREATE SEQUENCE test_scheduler_hook');
    await ds.query(`
      CREATE FUNCTION test_scheduler_hook() RETURNS trigger AS $$
      DECLARE k int;
      BEGIN
        k := nextval('public.test_scheduler_hook');
        IF k = ${atInsert} THEN ${action}; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public`);
    await ds.query('REVOKE ALL ON FUNCTION test_scheduler_hook() FROM PUBLIC');
    await ds.query(`CREATE TRIGGER test_scheduler_hook BEFORE INSERT ON executions
      FOR EACH ROW EXECUTE FUNCTION test_scheduler_hook()`);
  }

  it('creates one execution per moment when two instances tick over the same schedule at once', async () => {
    const { tenant } = await createTenant(ds);
    const [wf] = await schedule(tenant.id, '* * * * * *', 5_000);
    // Перше спрацювання першого інстансу тримає блокування рядка, поки другий тікає.
    await hook(1, 'PERFORM pg_sleep(1.5)');
    const [a, b] = [await instance(), await instance()];
    const first = a.tick();
    await waitFor('the first instance to hold the workflow row', async () => {
      const rows: unknown[] = await ds.query(
        `SELECT 1 FROM pg_stat_activity WHERE wait_event = 'PgSleep' AND query LIKE 'INSERT INTO "executions"%'`,
      );
      return rows.length > 0;
    });
    // Другий інстанс бачить зайнятий рядок (SKIP LOCKED) і нічого не створює, а не чекає.
    const started = Date.now();
    expect(await b.tick()).toBe(0);
    expect(Date.now() - started).toBeLessThan(1_000);
    const until = await dbNow(ds);
    await first;
    const times = await scheduledTimes(ds, wf);
    expect(new Set(times).size).toBe(times.length);
    // Усі моменти від курсора до тіку — створені (перший інстанс доробив пропуск сам).
    const [{ cursor }]: Array<{ cursor: Date }> = await ds.query(
      'SELECT "scheduleCursor" AS cursor FROM workflows WHERE id = $1',
      [wf],
    );
    expect(cursor.getTime()).toBe(times[times.length - 1]);
    for (let i = 1; i < times.length; i++)
      expect(times[i] - times[i - 1]).toBe(1_000);
    expect(times[times.length - 1]).toBeGreaterThanOrEqual(
      Math.floor(until.getTime() / 1000) * 1000 - 1_000,
    );
  });

  it('creates every moment exactly once when two instances race over many schedules', async () => {
    const tenants = [
      (await createTenant(ds, 'a')).tenant.id,
      (await createTenant(ds, 'b')).tenant.id,
    ];
    const ids: string[] = [];
    for (const t of tenants)
      ids.push(...(await schedule(t, '*/2 * * * * *', 20_000, 10)));
    const [a, b] = [await instance(), await instance()];
    const expected = new Map<string, number[]>();
    const before = await dbNow(ds);
    for (const id of ids)
      expected.set(id, await expectedMoments(id, 2_000, before));
    const [fa, fb] = await Promise.all([a.tick(), b.tick()]);
    const rows: Array<{ n: number }> = await ds.query(
      'SELECT count(*)::int AS n FROM executions',
    );
    expect(fa + fb).toBe(rows[0].n);
    for (const id of ids) {
      const times = await scheduledTimes(ds, id);
      expect(new Set(times).size).toBe(times.length);
      expect(times).toEqual(expect.arrayContaining(expected.get(id)!));
    }
  });

  it('resumes after the connection drops in the middle of a pass without losing or repeating a moment', async () => {
    const { tenant } = await createTenant(ds);
    const [wf] = await schedule(tenant.id, '* * * * * *', 10_000);
    // На четвертій вставці з'єднання планувальника обривається посеред транзакції.
    await hook(4, 'PERFORM pg_terminate_backend(pg_backend_pid())');
    const scheduler = await instance();
    await expect(scheduler.tick()).rejects.toThrow();
    const committed = await scheduledTimes(ds, wf);
    expect(committed).toHaveLength(3);
    const [{ cursor }]: Array<{ cursor: Date }> = await ds.query(
      'SELECT "scheduleCursor" AS cursor FROM workflows WHERE id = $1',
      [wf],
    );
    // Курсор — на останньому закоміченому моменті: обірвана транзакція нічого не зсунула.
    expect(cursor.getTime()).toBe(committed[2]);
    const before = await dbNow(ds);
    await scheduler.tick();
    const times = await scheduledTimes(ds, wf);
    expect(times.slice(0, 3)).toEqual(committed);
    expect(new Set(times).size).toBe(times.length);
    for (let i = 1; i < times.length; i++)
      expect(times[i] - times[i - 1]).toBe(1_000);
    expect(times[times.length - 1]).toBeGreaterThanOrEqual(
      Math.floor(before.getTime() / 1000) * 1000 - 1_000,
    );
  });

  it('treats a moment whose execution already exists as processed (retry after an unknown COMMIT)', async () => {
    const { tenant } = await createTenant(ds);
    const [wf] = await schedule(tenant.id, '* * * * * *', 3_000);
    // Виконання першого моменту вже є, а курсор ще до нього — так виглядає повтор після того, як
    // клієнт не отримав відповіді на COMMIT, але той відбувся іншим шляхом (страховка індексу).
    const [moment] = await expectedMoments(wf, 1_000, await dbNow(ds));
    await ds.query(
      `INSERT INTO executions("tenantId","workflowId","workflowVersionId",trigger,"scheduledAt")
       SELECT "tenantId", "workflowId", id, 'cron', $2 FROM workflow_versions WHERE "workflowId" = $1`,
      [wf, new Date(moment)],
    );
    const scheduler = await instance();
    await scheduler.tick();
    const times = await scheduledTimes(ds, wf);
    expect(times.filter((t) => t === moment)).toHaveLength(1);
    expect(times.length).toBeGreaterThan(1);
  });

  it('lets a SIGTERM finish the firing in progress before the pool closes', async () => {
    const { tenant } = await createTenant(ds);
    const [wf] = await schedule(tenant.id, '* * * * * *', 30_000);
    await hook(2, 'PERFORM pg_sleep(1)');
    const app = await startApp(undefined, { captureLogs: true });
    const scheduler = app.app.get(SchedulerService);
    scheduler.onApplicationShutdown();
    const ticking = scheduler.tick();
    await waitFor('the second firing to be in progress', async () => {
      const rows: unknown[] = await ds.query(
        `SELECT 1 FROM pg_stat_activity WHERE wait_event = 'PgSleep'`,
      );
      return rows.length > 0;
    });
    await app.close();
    const fired = await ticking;
    // Друге спрацювання дописане, а решту пропуску не почато: тік зупинився на завершенні.
    expect(fired).toBe(2);
    expect(await scheduledTimes(ds, wf)).toHaveLength(2);
    expect(
      app.logs.filter((l) => (l.level as number) >= 40).map((l) => l.msg),
    ).toEqual([]);
  });
});
