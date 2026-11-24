import { DataSource } from 'typeorm';
import {
  EXPIRED_LEASES_SQL,
  FINISH_EXECUTION_SQL,
  FINISHED_JOBS_SQL,
  PURGE_EXECUTIONS_SQL,
  PURGE_FINISHED_SQL,
} from '../../src/engine/job-queue.service';
import { openTestDataSource, truncateAll } from '../helpers/db';
import { testApiDatabaseUrl, testWorkerDatabaseUrl } from '../helpers/test-env';

interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  'Relation Name'?: string;
  'Index Cond'?: string;
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

  it('finds the watch of a changed execution through the primary key of realtime_watches', async () => {
    // Тригер notify_execution перевіряє підписку на кожну зміну виконання: пошук за ключем, а не
    // читання всіх підписок (по одній на кожне з 20 тис. виконань, як за найбільшого навантаження).
    await ds.query(`
      INSERT INTO realtime_watches ("executionId", "tenantId", "instanceId", "expiresAt")
      SELECT id, "tenantId", gen_random_uuid(), now() + interval '45 seconds' FROM executions`);
    await ds.query('ANALYZE realtime_watches');
    try {
      const body = await functionBody(ds, 'notify_execution', {});
      const id = "'00000000-0000-4000-8000-000000000000'::uuid";
      const select =
        /SELECT 1 FROM public\.realtime_watches[\s\S]*?clock_timestamp\(\)/
          .exec(body)![0]
          .replace(/= row_id\b/, `= ${id}`)
          .replace(/= tenant\b/, `= ${id}`);
      const [row]: Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }> =
        await ds.query(`EXPLAIN (FORMAT JSON) ${select}`);
      const root = row['QUERY PLAN'][0].Plan;
      expect(indexesIn(root)).toContain('realtime_watches_pkey');
      expect(hasSeqScan(root)).toBe(false);
    } finally {
      await ds.query('TRUNCATE realtime_watches');
    }
  });

  it('finishes by execution ID under the worker role without reading tenant history', async () => {
    const [job]: Array<{ id: string; tenantId: string; executionId: string }> =
      await ds.query('SELECT id, "tenantId", "executionId" FROM jobs LIMIT 1');
    const worker = await new DataSource({
      type: 'postgres',
      url: testWorkerDatabaseUrl(),
    }).initialize();
    try {
      const tree = await worker.transaction(async (em) => {
        await em.query("SELECT set_config('app.tenant_id', $1, true)", [
          job.tenantId,
        ]);
        const [row]: Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }> =
          await em.query(`EXPLAIN (FORMAT JSON) ${FINISH_EXECUTION_SQL}`, [
            job.id,
            job.tenantId,
            job.id,
            job.executionId,
            'true',
          ]);
        return row['QUERY PLAN'][0].Plan;
      });
      const reads = nodes(tree).filter(
        (n) =>
          n['Relation Name'] === 'executions' &&
          n['Node Type'].includes('Scan'),
      );
      expect(reads).toHaveLength(1);
      expect(reads[0]['Index Cond']).toContain(job.executionId);
    } finally {
      await worker.destroy();
    }
  });

  it('lists the executions of a tenant through its index under the API role and RLS', async () => {
    // Як ExecutionsService.list: роль API, контекст тенанта, предикат tenantId, найновіші першими.
    const [{ id }]: Array<{ id: string }> = await ds.query(
      `SELECT id FROM tenants ORDER BY id LIMIT 1`,
    );
    const api = await new DataSource({
      type: 'postgres',
      url: testApiDatabaseUrl(),
    }).initialize();
    try {
      const root = await api.transaction(async (em) => {
        await em.query(`SELECT set_config('app.tenant_id', $1, true)`, [id]);
        const [row]: Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }> =
          await em.query(
            `EXPLAIN (FORMAT JSON) SELECT * FROM executions
              WHERE "tenantId" = $1 ORDER BY "createdAt" DESC, id DESC LIMIT 50`,
            [id],
          );
        return row['QUERY PLAN'][0].Plan;
      });
      // Індекс узгоджений з порядком курсора, включно з однаковим часом.
      expect(indexesIn(root)).toContain('IDX_execution_page_tenant');
      expect(hasSeqScan(root)).toBe(false);
    } finally {
      await api.destroy();
    }
  });

  it('claims the next ready job of the chosen tenant through its queue index', async () => {
    // Той самий запит, що виконує claim_job (з каталогу), з тенантом як параметром.
    const body = await functionBody(ds, 'claim_job', {});
    const select = /SELECT q\.id FROM public\.jobs q[\s\S]*?SKIP LOCKED/
      .exec(body)![0]
      .replace('q."tenantId" = t', 'q."tenantId" = $1');
    const root = await ds.transaction(async (em) => {
      const [row]: Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }> =
        await em.query(`EXPLAIN (FORMAT JSON) ${select}`, [
          '00000000-0000-4000-8000-000000000000',
        ]);
      return row['QUERY PLAN'][0].Plan;
    });
    expect(indexesIn(root)).toContain('IDX_jobs_tenant_queue');
    expect(hasSeqScan(root)).toBe(false);
  });
});

/** Вибір пачки дозрілих тенантів для промоції з тіла claim_job (далі — UPDATE за їхніми id). */
const PROMOTE_SELECT =
  /SELECT m\."tenantId" FROM public\.tenant_usage m[\s\S]*?SKIP LOCKED/;

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
    // майбутні задачі, 1701..1720 — дозрілі, але промоція їх ще не обробила, решта — порожні.
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
                                         WHEN t.n BETWEEN 1701 AND 1720 THEN 1 ELSE 0 END) g
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
       WHERE t.id = u."tenantId" AND split_part(t.name, '-', 2)::int BETWEEN 1701 AND 1720`);
    await ds.query(`ANALYZE tenant_usage`);
    await ds.query(`ANALYZE jobs`);
  });

  afterAll(async () => {
    await truncateAll(ds);
    await ds.destroy();
  });

  /** EXPLAIN оператора з тіла claim_job у транзакції, що відкочується (оператори блокують). */
  async function explainInClaim(
    pattern: RegExp,
    replacements: Record<string, string>,
    options = 'ANALYZE, BUFFERS, FORMAT JSON',
  ): Promise<{ root: PlanNode; ms: number }> {
    const body = await functionBody(ds, 'claim_job', {});
    const statement = Object.entries(replacements).reduce(
      (sql, [from, to]) => sql.replace(from, to),
      pattern.exec(body)![0].replace(/;$/, ''),
    );
    const runner = ds.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const [row] = (await runner.query(
        `EXPLAIN (${options}) ${statement}`,
      )) as Array<{
        'QUERY PLAN': Array<{ Plan: PlanNode; 'Execution Time': number }>;
      }>;
      return {
        root: row['QUERY PLAN'][0].Plan,
        ms: row['QUERY PLAN'][0]['Execution Time'],
      };
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  }

  it('reads the candidate from the partial index in key order within 5 ms and 64 buffers', async () => {
    const { root, ms } = await explainInClaim(
      /SELECT u\."tenantId" INTO t FROM public\.tenant_usage u[\s\S]*?SKIP LOCKED/,
      { ' INTO t': '', 'ALL (tried)': "ALL ('{}'::uuid[])" },
    );
    expect(indexesIn(root)).toContain('IDX_tenant_usage_claim');
    expect(hasSeqScan(root)).toBe(false);
    expect(nodes(root).some((n) => n['Node Type'] === 'Sort')).toBe(false);
    expect(ms).toBeLessThanOrEqual(5);
    expect(
      (root['Shared Hit Blocks'] ?? 0) + (root['Shared Read Blocks'] ?? 0),
    ).toBeLessThanOrEqual(64);
  });

  it('promotes matured tenants through the maturing index, without a sequential scan', async () => {
    const { root } = await explainInClaim(PROMOTE_SELECT, {});
    expect(indexesIn(root)).toContain('IDX_tenant_usage_maturing');
    expect(hasSeqScan(root)).toBe(false);
    expect(
      nodes(root).find((n) => n['Index Name'] === 'IDX_tenant_usage_maturing'),
    ).toHaveProperty('Index Cond', expect.stringContaining('nextRunAt'));
  });

  it('claims for the best eligible tenant by (running, last claim, id), including just matured ones', async () => {
    const [best]: Array<{ tenantId: string }> = await ds.query(`
      SELECT "tenantId" FROM tenant_usage
       WHERE "nextRunAt" <= clock_timestamp() AND running < "maxRunning"
       ORDER BY running, "lastClaimedAt", "tenantId" LIMIT 1`);
    const runner = ds.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const [claimed] = (await runner.query(
        `SELECT (r.job)."tenantId" FROM claim_job('plan', 1000) r`,
      )) as Array<{ tenantId: string }>;
      expect(claimed.tenantId).toBe(best.tenantId);
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  });
  it('bounds idle promotion with 25000 tenants scheduled in the future', async () => {
    const body = await functionBody(ds, 'claim_job', {});
    const promote = PROMOTE_SELECT.exec(body)![0];
    await ds.transaction(async (em) => {
      await em.query(`INSERT INTO tenants(name,"apiKeyHash","webhookSecret")
        SELECT 'future-'||g, 'future-'||g, 'fixture' FROM generate_series(1,25000) g`);
      await em.query(
        `UPDATE tenant_usage SET ready=false,"nextRunAt"=now()+interval '1 day'`,
      );
      await em.query('ANALYZE tenant_usage');
      const [row]: Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }> =
        await em.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + promote);
      const root = row['QUERY PLAN'][0].Plan;
      expect(
        nodes(root).find(
          (n) => n['Index Name'] === 'IDX_tenant_usage_maturing',
        ),
      ).toHaveProperty('Index Cond', expect.stringContaining('nextRunAt'));
      expect(
        (root['Shared Hit Blocks'] ?? 0) + (root['Shared Read Blocks'] ?? 0),
      ).toBeLessThan(64);
    });
  });

  it('finds the next due job of an idle queue through the maturing index with 25000 tenants scheduled in the future', async () => {
    // Строк для сну чергового циклу (next_due_work): перший запис індексу дозрівання, а не
    // перебір усіх тенантів.
    const body = await functionBody(ds, 'next_due_work', {});
    const select =
      /SELECT LEAST[\s\S]*?FROM public\.tenant_usage u[\s\S]*?LIMIT 1/.exec(
        body,
      )![0];
    await ds.transaction(async (em) => {
      await em.query(`INSERT INTO tenants(name,"apiKeyHash","webhookSecret")
        SELECT 'due-'||g, 'due-'||g, 'fixture' FROM generate_series(1,25000) g`);
      await em.query(
        `UPDATE tenant_usage SET ready=false,"nextRunAt"=now()+make_interval(secs => random()*86400)`,
      );
      await em.query('ANALYZE tenant_usage');
      const [row]: Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }> =
        await em.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + select);
      const root = row['QUERY PLAN'][0].Plan;
      expect(indexesIn(root)).toContain('IDX_tenant_usage_maturing');
      expect(hasSeqScan(root)).toBe(false);
      expect(
        (root['Shared Hit Blocks'] ?? 0) + (root['Shared Read Blocks'] ?? 0),
      ).toBeLessThan(64);
    });
  });
});

/** Очищення відер частоти запитів — за індексом кінця вікна, без читання всієї таблиці. */
describe('purging rate limit buckets', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = await openTestDataSource();
    await truncateAll(ds);
    await ds.query(`
      INSERT INTO rate_limit_buckets (key, hits, "resetAt")
      SELECT 'tenant:' || g, 1, now() + make_interval(secs => g - 1000)
        FROM generate_series(1, 20000) g`);
    await ds.query(`ANALYZE rate_limit_buckets`);
  });

  afterAll(async () => {
    await truncateAll(ds);
    await ds.destroy();
  });

  it('selects expired buckets through their reset index', async () => {
    const body = await functionBody(ds, 'purge_rate_limits', {
      p_batch: '1000',
    });
    const select = /SELECT o\.key[\s\S]*?SKIP LOCKED/.exec(body)![0];
    const [row]: Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }> =
      await ds.query(`EXPLAIN (FORMAT JSON) ${select}`);
    const root = row['QUERY PLAN'][0].Plan;
    expect(indexesIn(root)).toContain('IDX_rate_limit_buckets_reset');
    expect(
      nodes(root).find(
        (n) => n['Index Name'] === 'IDX_rate_limit_buckets_reset',
      ),
    ).toHaveProperty('Index Cond', expect.stringContaining('resetAt'));
    expect(hasSeqScan(root)).toBe(false);
  });
});
