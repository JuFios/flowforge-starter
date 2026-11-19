import { DataSource } from 'typeorm';
import {
  CLAIM_CANDIDATE_SQL,
  EXPIRED_LEASES_SQL,
  FINISHED_JOBS_SQL,
  PURGE_EXECUTIONS_SQL,
  PURGE_FINISHED_SQL,
} from '../../src/engine/job-queue.service';
import { openTestDataSource, truncateAll } from '../helpers/db';

interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: PlanNode[];
}

function nodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(nodes)];
}

/** Тіло SQL-функції з каталогу (саме те, що виконується), з параметрами замість аргументів. */
async function functionBody(
  ds: DataSource,
  name: string,
  args: Record<string, string>,
): Promise<string> {
  const [{ src }]: Array<{ src: string }> = await ds.query(
    `SELECT prosrc AS src FROM pg_proc
      WHERE proname = $1 AND pronamespace = 'public'::regnamespace`,
    [name],
  );
  return Object.entries(args).reduce(
    (sql, [arg, param]) => sql.replaceAll(arg, param),
    src,
  );
}

function indexesIn(node: PlanNode): string[] {
  return [
    ...(node['Index Name'] ? [node['Index Name']] : []),
    ...(node.Plans ?? []).flatMap(indexesIn),
  ];
}

function hasSeqScan(node: PlanNode): boolean {
  return (
    node['Node Type'] === 'Seq Scan' || (node.Plans ?? []).some(hasSeqScan)
  );
}

/**
 * Гарячі запити черги використовують свої індекси на реалістичному розподілі даних: більшість
 * задач давно завершені, у черзі й у роботі — небагато.
 */
describe('query plans of the queue use their indexes', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = await openTestDataSource();
    await truncateAll(ds);
    // 50 тенантів; кожне з 20 тис. виконань має задачу й крок свого тенанта (композитні FK).
    await ds.query(`
      INSERT INTO tenants (name, "apiKeyHash", "webhookSecret")
      SELECT 'plan-' || g, md5('key-' || g) || md5('hash-' || g), 'secret'
        FROM generate_series(1, 50) g`);
    // Виконання: завершені, з ключем запуску в кожного десятого.
    await ds.query(`
      WITH t AS (SELECT id, row_number() OVER (ORDER BY id) - 1 AS n FROM tenants)
      INSERT INTO executions ("tenantId", "workflowId", status, "idempotencyKey", "finishedAt")
      SELECT t.id, gen_random_uuid(), 'succeeded',
             CASE WHEN g % 10 = 0 THEN 'key-' || g END,
             now() - (g || ' minutes')::interval
        FROM generate_series(1, 20000) g JOIN t ON t.n = g % 50`);
    await ds.query(`
      INSERT INTO jobs ("tenantId", "executionId", status, "runAt", "lockedUntil", "finishedAt")
      SELECT e."tenantId", e.id,
             CASE WHEN g % 400 = 0 THEN 'queued' WHEN g % 400 = 1 THEN 'running' ELSE 'done' END,
             now() - (g || ' seconds')::interval,
             CASE WHEN g % 400 = 1 THEN now() + interval '30 seconds' END,
             CASE WHEN g % 400 > 1 THEN now() - (g || ' minutes')::interval END
        FROM (SELECT id, "tenantId", row_number() OVER (ORDER BY id) AS g FROM executions) e`);
    await ds.query(`
      INSERT INTO step_runs ("executionId", "tenantId", "stepIndex", "stepId", status)
      SELECT id, "tenantId", 0, 'call', 'succeeded' FROM executions`);
    await ds.query(`ANALYZE executions`);
    await ds.query(`ANALYZE jobs`);
    await ds.query(`ANALYZE step_runs`);
  });

  afterAll(async () => {
    await truncateAll(ds);
    await ds.destroy();
  });

  async function plan(sql: string, params: unknown[] = []): Promise<PlanNode> {
    const [row]: Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }> =
      await ds.query(`EXPLAIN (FORMAT JSON) ${sql}`, params);
    return row['QUERY PLAN'][0].Plan;
  }

  it.each([
    [
      'claiming the next ready job of the chosen tenant',
      CLAIM_CANDIDATE_SQL,
      ['00000000-0000-4000-8000-000000000000'],
      'IDX_jobs_tenant_queue',
    ],
    [
      'finding expired leases of a tenant',
      EXPIRED_LEASES_SQL,
      ['00000000-0000-4000-8000-000000000000'],
      'IDX_jobs_lease',
    ],
    [
      'finding finished jobs past their retention period',
      FINISHED_JOBS_SQL,
      [7],
      'IDX_jobs_finished',
    ],
    [
      // Сам DELETE: пачка вибирається індексом очищення, а рядки видаляються за первинним
      // ключем — без читання всієї таблиці на кожну пачку.
      'deleting one batch of finished jobs',
      PURGE_FINISHED_SQL,
      [7],
      'IDX_jobs_finished',
    ],
    [
      // Пачка історії: вибір — індексом завершених виконань, видалення кроків, задач і виконань —
      // за ключами (без Seq Scan жодної з трьох таблиць).
      'deleting one batch of execution history',
      PURGE_EXECUTIONS_SQL,
      [7],
      'IDX_executions_finished',
    ],
    [
      'finding the job of an execution (retry, history cleanup)',
      `SELECT * FROM jobs WHERE "executionId" = $1`,
      ['00000000-0000-4000-8000-000000000000'],
      'IDX_jobs_execution',
    ],
    [
      'looking a run up by the Idempotency-Key of its tenant',
      `SELECT * FROM executions WHERE "tenantId" = $1 AND "idempotencyKey" = $2`,
      ['00000000-0000-4000-8000-000000000000', 'key-10'],
      'UQ_executions_idempotency_key',
    ],
    [
      'looking a step up by its idempotency key',
      `SELECT * FROM step_runs WHERE "idempotencyKey" = $1`,
      ['00000000-0000-4000-8000-000000000000'],
      'UQ_step_runs_idempotency_key',
    ],
    [
      'loading the checkpoints of an execution',
      `SELECT * FROM step_runs WHERE "executionId" = $1 ORDER BY "stepIndex"`,
      ['00000000-0000-4000-8000-000000000000'],
      'UQ_step_runs_execution_step',
    ],
  ])('%s', async (_case, sql, params, index) => {
    const root = await plan(sql, params);
    expect(indexesIn(root)).toContain(index);
    expect(hasSeqScan(root)).toBe(false);
  });
});

/**
 * Вибір кандидата на захоплення (README, 3.3.5) на 2000 тенантах: готові, насичені з різними
 * лімітами, лише з майбутніми задачами, дозрілі, але не просунуті, і порожні. Гілка (a) — Index
 * Scan за частковим індексом у порядку ключа (без Sort), тож час і кількість прочитаних сторінок
 * не залежать від кількості насичених і неготових тенантів.
 */
describe('choosing a claim candidate among 2000 tenants', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = await openTestDataSource();
    await truncateAll(ds);
    // n 1..1000 — готові (0–2 у роботі), 1001..1400 — насичені (ліміт 1..5), 1401..1700 — лише
    // майбутні задачі, 1701..1750 — дозрілі, але промоція їх ще не обробила, решта — порожні.
    await ds.query(`
      INSERT INTO tenants (name, "apiKeyHash", "webhookSecret", "maxConcurrentExecutions")
      SELECT 'c-' || g, md5('key-' || g) || md5('hash-' || g), 'secret',
             CASE WHEN g BETWEEN 1001 AND 1400 THEN 1 + g % 5 END
        FROM generate_series(1, 2000) g`);
    // Одне виконання на задачу (завершене: версія для плану не потрібна); стан і час задачі — у
    // вході виконання.
    await ds.query(`
      WITH t AS (SELECT id, split_part(name, '-', 2)::int AS n, "maxConcurrentExecutions" AS lim
                   FROM tenants)
      INSERT INTO executions ("tenantId", "workflowId", status, "finishedAt", input)
      SELECT t.id, gen_random_uuid(), 'succeeded', now(),
             jsonb_build_object('status', s.status, 'runAt', s.run_at)
        FROM t, LATERAL (
          SELECT 'queued' AS status, now() - make_interval(mins => g) AS run_at
            FROM generate_series(1, CASE WHEN t.n <= 1000 THEN 1 + t.n % 3
                                         WHEN t.n <= 1400 THEN 2
                                         WHEN t.n BETWEEN 1701 AND 1750 THEN 1 ELSE 0 END) g
          UNION ALL
          SELECT 'queued', now() + interval '1 hour'
            FROM generate_series(1, CASE WHEN t.n BETWEEN 1401 AND 1700 THEN 1 ELSE 0 END)
          UNION ALL
          SELECT 'running', now()
            FROM generate_series(1, CASE WHEN t.n <= 1000 THEN t.n % 3
                                         WHEN t.n <= 1400 THEN t.lim ELSE 0 END)
        ) s`);
    await ds.query(`
      INSERT INTO jobs ("tenantId", "executionId", status, "runAt", "lockToken", "lockedUntil")
      SELECT "tenantId", id, input->>'status', (input->>'runAt')::timestamptz,
             CASE WHEN input->>'status' = 'running' THEN gen_random_uuid() END,
             CASE WHEN input->>'status' = 'running' THEN now() + interval '1 hour' END
        FROM executions`);
    // Відставання промоції: тенанти з настилою задачею, яких промоція ще не просунула.
    await ds.query(`
      UPDATE tenant_usage u SET ready = false FROM tenants t
       WHERE t.id = u."tenantId" AND split_part(t.name, '-', 2)::int BETWEEN 1701 AND 1750`);
    await ds.query(`ANALYZE tenant_usage`);
    await ds.query(`ANALYZE jobs`);
  });

  afterAll(async () => {
    await truncateAll(ds);
    await ds.destroy();
  });

  it('reads the candidate from the partial indexes within 5 ms and 64 buffers', async () => {
    const sql = await functionBody(ds, 'claim_candidate', {
      p_exclude: '$1::uuid[]',
    });
    const [row]: Array<{
      'QUERY PLAN': Array<{ Plan: PlanNode; 'Execution Time': number }>;
    }> = await ds.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, [[]]);
    const { Plan: root, 'Execution Time': ms } = row['QUERY PLAN'][0];
    expect(hasSeqScan(root)).toBe(false);
    const branches = nodes(root).find(
      (n) => n['Node Type'] === 'Append',
    )!.Plans!;
    const ready = branches.find((b) =>
      indexesIn(b).includes('IDX_tenant_usage_claim'),
    )!;
    expect(ready).toBeDefined();
    expect(nodes(ready).some((n) => n['Node Type'] === 'Sort')).toBe(false);
    expect(
      branches.some((b) => indexesIn(b).includes('IDX_tenant_usage_maturing')),
    ).toBe(true);
    expect(ms).toBeLessThanOrEqual(5);
    expect(
      (root['Shared Hit Blocks'] ?? 0) + (root['Shared Read Blocks'] ?? 0),
    ).toBeLessThanOrEqual(64);
  });

  it('returns the best eligible tenant by (running, last claim, id), promoted or not', async () => {
    const [best]: Array<{ tenantId: string }> = await ds.query(`
      SELECT "tenantId" FROM tenant_usage
       WHERE "nextRunAt" <= clock_timestamp() AND running < "maxRunning"
       ORDER BY running, "lastClaimedAt", "tenantId" LIMIT 1`);
    const [chosen]: Array<{ tenantId: string }> = await ds.query(
      `SELECT "tenantId" FROM claim_candidate('{}')`,
    );
    expect(chosen.tenantId).toBe(best.tenantId);
  });

  it('promotes matured tenants through the maturing index, without a sequential scan', async () => {
    const body = await functionBody(ds, 'promote_ready_tenants', {
      p_batch: '100',
    });
    const update = /UPDATE public\.tenant_usage[\s\S]*?;/.exec(body)![0];
    const root = await ds.transaction(async (em) => {
      const [row]: Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }> =
        await em.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${update.slice(0, -1)}`);
      // Лише план: зміни відкочуються.
      await em.query('ROLLBACK');
      await em.query('BEGIN');
      return row['QUERY PLAN'][0].Plan;
    });
    expect(indexesIn(root)).toContain('IDX_tenant_usage_maturing');
    expect(hasSeqScan(root)).toBe(false);
  });
});
