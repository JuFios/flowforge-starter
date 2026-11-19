import { lockClusterRoles } from '../cluster-role-lock';
import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  assertRolesUnclaimed,
  assertServiceRolesPristine,
  MIN_SERVER_VERSION,
} from '../../tenancy/login-role-check';
import { API_ROLE, SYSTEM_ROLE, WORKER_ROLE } from '../../tenancy/roles';

/** Тенантні таблиці: на кожній — RLS з FORCE і політика за тенантом. */
export const TENANT_TABLES = [
  'tenants',
  'workflows',
  'workflow_versions',
  'executions',
  'step_runs',
  'jobs',
] as const;

/** Перевірки цілісності перед композитними FK: лише кількості, без даних тенантів. */
const ORPHAN_CHECKS: Array<[string, string]> = [
  [
    'jobs without their execution',
    `SELECT count(*) FROM jobs j WHERE NOT EXISTS (SELECT FROM executions e WHERE e.id = j."executionId")`,
  ],
  [
    'step_runs without their execution',
    `SELECT count(*) FROM step_runs s WHERE NOT EXISTS (SELECT FROM executions e WHERE e.id = s."executionId")`,
  ],
  [
    'jobs whose tenant differs from their execution',
    `SELECT count(*) FROM jobs j JOIN executions e ON e.id = j."executionId" WHERE e."tenantId" <> j."tenantId"`,
  ],
  [
    'executions whose snapshot belongs to another tenant',
    `SELECT count(*) FROM executions e JOIN workflow_versions v ON v.id = e."workflowVersionId" WHERE v."tenantId" <> e."tenantId"`,
  ],
  [
    'workflows of an unknown tenant',
    `SELECT count(*) FROM workflows w WHERE NOT EXISTS (SELECT FROM tenants t WHERE t.id = w."tenantId")`,
  ],
  [
    'workflow versions of an unknown tenant',
    `SELECT count(*) FROM workflow_versions v WHERE NOT EXISTS (SELECT FROM tenants t WHERE t.id = v."tenantId")`,
  ],
  [
    'executions of an unknown tenant',
    `SELECT count(*) FROM executions e WHERE NOT EXISTS (SELECT FROM tenants t WHERE t.id = e."tenantId")`,
  ],
  [
    'jobs of an unknown tenant',
    `SELECT count(*) FROM jobs j WHERE NOT EXISTS (SELECT FROM tenants t WHERE t.id = j."tenantId")`,
  ],
];

/** Права runtime-ролей на таблиці (§«Операції → права» у README; перевіряє db-acl.int-spec). */
const GRANTS: Array<[string, string, string]> = [
  [API_ROLE, 'tenants', 'SELECT, INSERT, UPDATE'],
  [API_ROLE, 'workflows', 'SELECT, INSERT, UPDATE, DELETE'],
  [API_ROLE, 'workflow_versions', 'SELECT, INSERT'],
  [API_ROLE, 'executions', 'SELECT, INSERT, UPDATE'],
  [API_ROLE, 'step_runs', 'SELECT'],
  [API_ROLE, 'jobs', 'SELECT, INSERT, UPDATE'],
  [WORKER_ROLE, 'workflow_versions', 'SELECT'],
  [WORKER_ROLE, 'executions', 'SELECT, UPDATE'],
  [WORKER_ROLE, 'step_runs', 'SELECT, INSERT, UPDATE'],
  [WORKER_ROLE, 'jobs', 'SELECT, UPDATE'],
];

/** Спільні атрибути SECURITY DEFINER-функцій: pg_temp — явно останнім (документація Postgres). */
const DEFINER = `SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp`;

/**
 * SECURITY DEFINER-функції: єдиний крос-тенантний доступ runtime-ролей. Вони віддають лише
 * ідентифікатори й кількості, не дані тенантів; самі рядки читаються й змінюються під RLS у
 * контексті конкретного тенанта.
 */
const FUNCTIONS: Array<{ signature: string; grantee: string; sql: string }> = [
  {
    // Автентифікація за API-ключем: id тенанта за sha256-хешем ключа (секретів не віддає).
    signature: 'auth_tenant(text)',
    grantee: API_ROLE,
    sql: `CREATE FUNCTION public.auth_tenant(p_api_key_hash text) RETURNS uuid
      LANGUAGE sql STABLE ${DEFINER} AS $$
        SELECT t.id FROM public.tenants t
         WHERE p_api_key_hash IS NOT NULL AND pg_catalog.length(p_api_key_hash) = 64
           AND t."apiKeyHash" = p_api_key_hash
      $$`,
  },
  {
    // Вхідний webhook: тенант увімкненого workflow (підпис перевіряється вже в його контексті).
    signature: 'webhook_tenant(uuid)',
    grantee: API_ROLE,
    sql: `CREATE FUNCTION public.webhook_tenant(p_workflow_id uuid) RETURNS uuid
      LANGUAGE sql STABLE ${DEFINER} AS $$
        SELECT w."tenantId" FROM public.workflows w WHERE w.id = p_workflow_id AND w.enabled
      $$`,
  },
  {
    // Планувальник: workflow з розкладом сторінками за id (keyset), щонайбільше 1000 за раз.
    signature: 'scheduled_workflows(uuid, integer)',
    grantee: API_ROLE,
    sql: `CREATE FUNCTION public.scheduled_workflows(p_after uuid, p_limit integer)
      RETURNS TABLE (id uuid, "tenantId" uuid)
      LANGUAGE sql STABLE ${DEFINER} AS $$
        SELECT w.id, w."tenantId" FROM public.workflows w
         WHERE w.enabled AND w.cron IS NOT NULL AND (p_after IS NULL OR w.id > p_after)
         ORDER BY w.id
         LIMIT LEAST(GREATEST(p_limit, 1), 1000)
      $$`,
  },
  {
    // Захоплення (FIFO): найраніша готова задача, заблокована до кінця транзакції викликача.
    // Воркер захоплює саме її вже під RLS у контексті її тенанта.
    signature: 'claim_fifo_candidate()',
    grantee: WORKER_ROLE,
    sql: `CREATE FUNCTION public.claim_fifo_candidate()
      RETURNS TABLE (id uuid, "tenantId" uuid)
      LANGUAGE sql VOLATILE ${DEFINER} AS $$
        SELECT j.id, j."tenantId" FROM public.jobs j
         WHERE j.status = 'queued' AND j."runAt" <= pg_catalog.now()
         ORDER BY j."runAt"
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      $$`,
  },
  {
    // Reaper: тенанти, у яких є задачі з простроченим lease, крім уже оброблених у цьому проході
    // (обробляються по одному під RLS).
    signature: 'expired_lease_tenants(uuid[], integer)',
    grantee: WORKER_ROLE,
    sql: `CREATE FUNCTION public.expired_lease_tenants(p_exclude uuid[], p_limit integer)
      RETURNS SETOF uuid
      LANGUAGE sql STABLE ${DEFINER} AS $$
        SELECT DISTINCT j."tenantId" FROM public.jobs j
         WHERE j.status = 'running' AND j."lockedUntil" < pg_catalog.now()
           AND j."tenantId" <> ALL (COALESCE(p_exclude, '{}'))
         ORDER BY 1
         LIMIT LEAST(GREATEST(p_limit, 1), 1000)
      $$`,
  },
  {
    // Очищення: одна пачка завершених задач, старших за термін (див. PURGE_FINISHED_SQL).
    signature: 'purge_finished_jobs(integer, integer)',
    grantee: WORKER_ROLE,
    sql: `CREATE FUNCTION public.purge_finished_jobs(p_days integer, p_batch integer)
      RETURNS integer
      LANGUAGE plpgsql VOLATILE ${DEFINER} AS $$
      DECLARE deleted integer;
      BEGIN
        IF p_days IS NULL OR p_days < 1 THEN
          RAISE EXCEPTION 'retention must be at least one day';
        END IF;
        DELETE FROM public.jobs WHERE id = ANY (ARRAY(
          SELECT j.id FROM public.jobs j
           WHERE j.status IN ('done', 'failed', 'dead')
             AND j."finishedAt" < pg_catalog.now() - pg_catalog.make_interval(days => p_days)
           ORDER BY j."finishedAt"
           LIMIT LEAST(GREATEST(p_batch, 1), 10000)
           FOR UPDATE SKIP LOCKED));
        GET DIAGNOSTICS deleted = ROW_COUNT;
        RETURN deleted;
      END $$`,
  },
  {
    // Очищення історії: пачка завершених виконань разом із кроками й задачами, одним оператором.
    signature: 'purge_execution_history(integer, integer)',
    grantee: WORKER_ROLE,
    sql: `CREATE FUNCTION public.purge_execution_history(p_days integer, p_batch integer)
      RETURNS integer
      LANGUAGE plpgsql VOLATILE ${DEFINER} AS $$
      DECLARE deleted integer;
      BEGIN
        IF p_days IS NULL OR p_days < 1 THEN
          RAISE EXCEPTION 'retention must be at least one day';
        END IF;
        WITH batch AS (SELECT ARRAY(
               SELECT e.id FROM public.executions e
                WHERE e.status IN ('succeeded', 'failed')
                  AND e."finishedAt" < pg_catalog.now() - pg_catalog.make_interval(days => p_days)
                ORDER BY e."finishedAt"
                LIMIT LEAST(GREATEST(p_batch, 1), 10000)
                FOR UPDATE SKIP LOCKED) AS ids),
             steps AS (DELETE FROM public.step_runs s USING batch b WHERE s."executionId" = ANY (b.ids)),
             queue AS (DELETE FROM public.jobs j USING batch b WHERE j."executionId" = ANY (b.ids))
        DELETE FROM public.executions e USING batch b WHERE e.id = ANY (b.ids);
        GET DIAGNOSTICS deleted = ROW_COUNT;
        RETURN deleted;
      END $$`,
  },
];

/**
 * Ізоляція тенантів на рівні Postgres (ТЗ 3.3.4): ролі без BYPASSRLS, RLS з FORCE на кожній
 * тенантній таблиці, композитні FK між таблицями одного тенанта і вузькі SECURITY DEFINER-функції
 * для крос-тенантних операцій. Виконується суперкористувачем (створення ролі з BYPASSRLS і
 * backfill під FORCE RLS вимагають саме його).
 */
export class TenantIsolation1795100000000 implements MigrationInterface {
  name = 'TenantIsolation1795100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const [{ superuser }] = (await queryRunner.query(
      `SELECT rolsuper AS superuser FROM pg_roles WHERE rolname = current_user`,
    )) as Array<{ superuser: boolean }>;
    if (!superuser)
      throw new Error(
        'migrations must run as a PostgreSQL superuser: they create a BYPASSRLS role and backfill tables under FORCE ROW LEVEL SECURITY',
      );
    const [{ version }] = (await queryRunner.query(
      `SELECT current_setting('server_version_num')::int AS version`,
    )) as Array<{ version: number }>;
    if (version < MIN_SERVER_VERSION)
      throw new Error(
        'PostgreSQL 16 or newer is required: tenant isolation relies on its role membership rules',
      );

    await lockClusterRoles((sql) => queryRunner.query(sql));
    for (const [what, sql] of ORPHAN_CHECKS) {
      const [{ count }] = (await queryRunner.query(sql)) as Array<{
        count: string;
      }>;
      if (Number(count) > 0)
        throw new Error(
          `cannot enforce tenant integrity: ${count} ${what}; resolve them before migrating`,
        );
    }

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${API_ROLE}') THEN
          CREATE ROLE ${API_ROLE} NOLOGIN;
        END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${WORKER_ROLE}') THEN
          CREATE ROLE ${WORKER_ROLE} NOLOGIN;
        END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${SYSTEM_ROLE}') THEN
          CREATE ROLE ${SYSTEM_ROLE} NOLOGIN;
        END IF;
      END $$`);
    // Ролі спільні для кластера: наявні могли створити чи «засвоїти» інші користувачі. Сторонній
    // член отримав би BYPASSRLS або змогу виставити собі будь-який app.tenant_id.
    const query = (sql: string, params?: unknown[]): Promise<unknown> =>
      queryRunner.query(sql, params);
    await assertRolesUnclaimed(query);
    // Наявні ролі не «лагодяться»: атрибути мають бути саме такими, з якими їх створює ця міграція,
    // і жодної сесії під ними. Єдина зміна — BYPASSRLS системній ролі (щоб тіла її функцій бачили
    // всі рядки); для ролі, що вже його має (інша БД кластера), вона нічого не змінює.
    await assertServiceRolesPristine(query);
    await queryRunner.query(`ALTER ROLE ${SYSTEM_ROLE} BYPASSRLS`);

    // Ніхто, крім власника, не створює об'єктів у public (захист від підміни імен у search_path).
    await queryRunner.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
    await queryRunner.query(
      `GRANT USAGE ON SCHEMA public TO ${API_ROLE}, ${WORKER_ROLE}, ${SYSTEM_ROLE}`,
    );

    await queryRunner.query(`
      CREATE FUNCTION public.app_current_tenant() RETURNS uuid
        LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
          SELECT CASE WHEN s ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                      THEN s::uuid END
            FROM (SELECT current_setting('app.tenant_id', true) AS s) AS setting
        $$`);
    await queryRunner.query(
      `REVOKE ALL ON FUNCTION public.app_current_tenant() FROM PUBLIC`,
    );
    await queryRunner.query(
      `GRANT EXECUTE ON FUNCTION public.app_current_tenant() TO ${API_ROLE}, ${WORKER_ROLE}, ${SYSTEM_ROLE}`,
    );

    // Кроки отримують тенанта свого виконання.
    await queryRunner.query(`ALTER TABLE "step_runs" ADD "tenantId" uuid`);
    await queryRunner.query(
      `UPDATE step_runs s SET "tenantId" = e."tenantId" FROM executions e WHERE e.id = s."executionId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "step_runs" ALTER COLUMN "tenantId" SET NOT NULL`,
    );
    for (const table of [
      'workflows',
      'workflow_versions',
      'executions',
      'jobs',
      'step_runs',
    ])
      await queryRunner.query(
        `ALTER TABLE "${table}" ALTER COLUMN "tenantId" SET DEFAULT app_current_tenant()`,
      );

    await queryRunner.query(
      `ALTER TABLE "workflow_versions" ADD CONSTRAINT "UQ_workflow_versions_id_tenant" UNIQUE ("id", "tenantId")`,
    );
    await queryRunner.query(
      `ALTER TABLE "executions" ADD CONSTRAINT "UQ_executions_id_tenant" UNIQUE ("id", "tenantId")`,
    );
    await queryRunner.query(
      `ALTER TABLE "executions" DROP CONSTRAINT "FK_d7a80c20eaa0c1916248aeaa579"`,
    );
    await queryRunner.query(
      `ALTER TABLE "executions" ADD CONSTRAINT "FK_executions_version_tenant" FOREIGN KEY ("workflowVersionId", "tenantId") REFERENCES "workflow_versions"("id","tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    for (const [table, name] of [
      ['workflows', 'FK_workflows_tenant'],
      ['workflow_versions', 'FK_workflow_versions_tenant'],
      ['executions', 'FK_executions_tenant'],
      ['jobs', 'FK_jobs_tenant'],
    ])
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD CONSTRAINT "${name}" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
      );
    await queryRunner.query(
      `ALTER TABLE "step_runs" ADD CONSTRAINT "FK_step_runs_execution_tenant" FOREIGN KEY ("executionId", "tenantId") REFERENCES "executions"("id","tenantId") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "jobs" ADD CONSTRAINT "FK_jobs_execution_tenant" FOREIGN KEY ("executionId", "tenantId") REFERENCES "executions"("id","tenantId") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );

    for (const table of TENANT_TABLES) {
      const column = table === 'tenants' ? 'id' : 'tenantId';
      await queryRunner.query(
        `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`,
      );
      await queryRunner.query(
        `CREATE POLICY tenant_isolation ON "${table}"
           USING ("${column}" = public.app_current_tenant())
           WITH CHECK ("${column}" = public.app_current_tenant())`,
      );
      await queryRunner.query(
        `REVOKE ALL ON "${table}" FROM PUBLIC, ${API_ROLE}, ${WORKER_ROLE}, ${SYSTEM_ROLE}`,
      );
      await queryRunner.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON "${table}" TO ${SYSTEM_ROLE}`,
      );
    }
    for (const [role, table, privileges] of GRANTS)
      await queryRunner.query(`GRANT ${privileges} ON "${table}" TO ${role}`);
    await queryRunner.query(
      `REVOKE ALL ON "migrations" FROM PUBLIC, ${API_ROLE}, ${WORKER_ROLE}, ${SYSTEM_ROLE}`,
    );

    for (const fn of FUNCTIONS) {
      await queryRunner.query(fn.sql);
      await queryRunner.query(
        `ALTER FUNCTION public.${fn.signature} OWNER TO ${SYSTEM_ROLE}`,
      );
      await queryRunner.query(
        `REVOKE ALL ON FUNCTION public.${fn.signature} FROM PUBLIC`,
      );
      await queryRunner.query(
        `GRANT EXECUTE ON FUNCTION public.${fn.signature} TO ${fn.grantee}`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const fn of [...FUNCTIONS].reverse())
      await queryRunner.query(`DROP FUNCTION public.${fn.signature}`);
    await queryRunner.query(
      `REVOKE ALL ON "migrations" FROM ${API_ROLE}, ${WORKER_ROLE}, ${SYSTEM_ROLE}`,
    );
    for (const table of [...TENANT_TABLES].reverse()) {
      await queryRunner.query(
        `REVOKE ALL ON "${table}" FROM ${API_ROLE}, ${WORKER_ROLE}, ${SYSTEM_ROLE}`,
      );
      await queryRunner.query(`DROP POLICY tenant_isolation ON "${table}"`);
      await queryRunner.query(
        `ALTER TABLE "${table}" NO FORCE ROW LEVEL SECURITY`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" DISABLE ROW LEVEL SECURITY`,
      );
    }
    await queryRunner.query(
      `ALTER TABLE "jobs" DROP CONSTRAINT "FK_jobs_execution_tenant"`,
    );
    await queryRunner.query(
      `ALTER TABLE "step_runs" DROP CONSTRAINT "FK_step_runs_execution_tenant"`,
    );
    for (const [table, name] of [
      ['jobs', 'FK_jobs_tenant'],
      ['executions', 'FK_executions_tenant'],
      ['workflow_versions', 'FK_workflow_versions_tenant'],
      ['workflows', 'FK_workflows_tenant'],
    ])
      await queryRunner.query(
        `ALTER TABLE "${table}" DROP CONSTRAINT "${name}"`,
      );
    await queryRunner.query(
      `ALTER TABLE "executions" DROP CONSTRAINT "FK_executions_version_tenant"`,
    );
    await queryRunner.query(
      `ALTER TABLE "executions" ADD CONSTRAINT "FK_d7a80c20eaa0c1916248aeaa579" FOREIGN KEY ("workflowVersionId") REFERENCES "workflow_versions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "executions" DROP CONSTRAINT "UQ_executions_id_tenant"`,
    );
    await queryRunner.query(
      `ALTER TABLE "workflow_versions" DROP CONSTRAINT "UQ_workflow_versions_id_tenant"`,
    );
    for (const table of [
      'workflows',
      'workflow_versions',
      'executions',
      'jobs',
    ])
      await queryRunner.query(
        `ALTER TABLE "${table}" ALTER COLUMN "tenantId" DROP DEFAULT`,
      );
    await queryRunner.query(`ALTER TABLE "step_runs" DROP COLUMN "tenantId"`);
    await queryRunner.query(`DROP FUNCTION public.app_current_tenant()`);
    await queryRunner.query(
      `REVOKE USAGE ON SCHEMA public FROM ${API_ROLE}, ${WORKER_ROLE}, ${SYSTEM_ROLE}`,
    );
  }
}
