import { DataSource, MigrationExecutor } from 'typeorm';
import { validateDatabaseEnv } from '../../src/config/env.validation';
import { buildDataSourceOptions } from '../../src/database/database.options';
import { MIGRATION_LOCK_KEY, migrate } from '../../src/database/migrate';
import { findPostureViolations } from '../../src/tenancy/security-posture';
import { SYSTEM_ROLE, WORKER_ROLE } from '../../src/tenancy/roles';
import { openTestDataSource } from '../helpers/db';
import { clusterScopedName, testDatabaseUrl } from '../helpers/test-env';

/** Стороння роль кластера, якій «чужий» стан каталогу видає права (не FlowForge). */
const REPORTER = clusterScopedName('ff_reporter_test');
/** Порожня БД, яку мігрують у кожному сценарії заново. */
const SCRATCH_DB = clusterScopedName('ff_posture_test');

/**
 * `db:migrate` не підтримує каталог, який сформував хтось, крім FlowForge (README 3.3.4, «Модель
 * загроз»), а виявляє його й відмовляє, нічого не змінивши. Сценарії — різні варіанти одного
 * класу «чужий грант / політика / роль»: стороння роль будь-якого імені, PUBLIC, default privileges.
 */
describe('db:migrate refuses a catalog that FlowForge did not shape', () => {
  let owner: DataSource;
  let scratch: DataSource | undefined;

  function scratchUrl(): string {
    const url = new URL(testDatabaseUrl());
    url.pathname = `/${SCRATCH_DB}`;
    return url.toString();
  }

  function openScratch(): Promise<DataSource> {
    return new DataSource(
      buildDataSourceOptions(
        validateDatabaseEnv({ DATABASE_URL: scratchUrl() }),
        { statementTimeout: false },
      ),
    ).initialize();
  }

  /** Нова порожня БД і підключення власника до неї з переліком міграцій застосунку. */
  async function freshScratch(): Promise<DataSource> {
    await scratch?.destroy();
    scratch = undefined;
    await owner.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await owner.query(`CREATE DATABASE ${SCRATCH_DB}`);
    scratch = await openScratch();
    return scratch;
  }

  async function tableExists(ds: DataSource, name: string): Promise<boolean> {
    const [{ found }]: Array<{ found: boolean }> = await ds.query(
      `SELECT pg_catalog.to_regclass($1) IS NOT NULL AS found`,
      [`public.${name}`],
    );
    return found;
  }

  beforeAll(async () => {
    owner = await openTestDataSource();
    await owner.query(`DROP ROLE IF EXISTS ${REPORTER}`);
    await owner.query(`CREATE ROLE ${REPORTER} NOLOGIN`);
  });

  afterAll(async () => {
    await scratch?.destroy();
    await owner.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await owner.query(`DROP ROLE IF EXISTS ${REPORTER}`);
    await owner.destroy();
  });

  it('requires a tenant relation to be a table covered by the policy inspection', async () => {
    const ds = await freshScratch();
    await migrate(ds);
    await ds.query('DROP TABLE webhook_deliveries');
    await ds.query(
      'CREATE VIEW webhook_deliveries AS SELECT NULL::uuid AS "tenantId" WHERE false',
    );
    await ds.query(
      'GRANT SELECT,INSERT ON webhook_deliveries TO flowforge_api_role',
    );
    await expect(migrate(ds)).rejects.toThrow(/webhook_deliveries/);
  });

  it('applies every migration to an empty database and accepts a repeated run', async () => {
    const ds = await freshScratch();
    expect(await migrate(ds)).toHaveLength(ds.migrations.length);
    expect(await migrate(ds)).toEqual([]);
    expect(await findPostureViolations((sql, p) => ds.query(sql, p))).toEqual(
      [],
    );
  });

  it('applies the migrations once when two deployments run at the same time', async () => {
    const ds = await freshScratch();
    const other = await openScratch();
    try {
      const [first, second] = await Promise.all([migrate(ds), migrate(other)]);
      expect(first.length + second.length).toBe(ds.migrations.length);
    } finally {
      await other.destroy();
    }
    const [{ count }]: Array<{ count: number }> = await ds.query(
      `SELECT count(*)::int AS count FROM migrations`,
    );
    expect(count).toBe(ds.migrations.length);
  });

  it('gives up with a clear error instead of waiting forever for a stuck migration lock', async () => {
    const ds = await freshScratch();
    const holder = await openScratch();
    try {
      await holder.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
      await expect(migrate(ds, { lockWaitMs: 300 })).rejects.toThrow(
        /another db:migrate has held the migration lock/,
      );
      expect(await tableExists(ds, 'migrations')).toBe(false);
    } finally {
      await holder.destroy();
    }
    await expect(migrate(ds)).resolves.toHaveLength(ds.migrations.length);
  });

  // ALTER DEFAULT PRIVILEGES того, хто мігрує: кожна нова функція чи таблиця одразу отримує грант
  // сторонній ролі, а REVOKE ... FROM PUBLIC його не знімає.
  it.each([
    [
      'functions',
      'EXECUTE ON FUNCTIONS',
      /function purge_execution_history\(integer,integer\) grants ff_reporter_test_\w+ EXECUTE/,
    ],
    [
      'tables',
      'SELECT ON TABLES',
      /relation executions grants ff_reporter_test_\w+ SELECT/,
    ],
  ])(
    'refuses default privileges that grant new %s to a foreign role and changes nothing',
    async (_kind, privilege, problem) => {
      const ds = await freshScratch();
      await ds.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ${privilege} TO ${REPORTER}`,
      );
      await expect(migrate(ds)).rejects.toThrow(problem);
      expect(await tableExists(ds, 'executions')).toBe(false);
      expect(await tableExists(ds, 'migrations')).toBe(false);
      const [{ bypass }]: Array<{ bypass: boolean }> = await ds.query(
        `SELECT rolbypassrls AS bypass FROM pg_roles WHERE rolname = $1`,
        [SYSTEM_ROLE],
      );
      // Роль спільна для кластера: BYPASSRLS у неї вже від тестової БД, а не від цієї спроби.
      expect(bypass).toBe(true);
    },
  );

  // Після розгортання хтось змінив каталог вручну: наступний запуск міграцій це виявляє.
  it.each([
    [
      'a permissive policy that opens every row',
      [`CREATE POLICY open_read ON executions FOR SELECT USING (true)`],
      /unexpected policy open_read on table executions/,
    ],
    [
      'a column grant to a foreign role',
      [`GRANT SELECT (name) ON tenants TO ${REPORTER}`],
      /table tenants has column-level grants/,
    ],
    [
      'EXECUTE on a service function for PUBLIC',
      [`GRANT EXECUTE ON FUNCTION claim_job(text, integer) TO PUBLIC`],
      /function claim_job\(text,integer\) grants PUBLIC EXECUTE/,
    ],
    [
      'CREATE in schema public for a foreign role',
      [`GRANT CREATE ON SCHEMA public TO ${REPORTER}`],
      /ff_reporter_test_\w+ can create objects in schema public/,
    ],
    [
      'a foreign function the worker group may execute',
      [
        `CREATE FUNCTION public.ff_extra() RETURNS integer LANGUAGE sql AS 'SELECT 1'`,
        `REVOKE ALL ON FUNCTION public.ff_extra() FROM PUBLIC`,
        `GRANT EXECUTE ON FUNCTION public.ff_extra() TO ${WORKER_ROLE}`,
      ],
      /unexpected function ff_extra\(\) grants EXECUTE to flowforge_worker_role/,
    ],
    [
      'a view owned by the system role outside schema public',
      [
        `CREATE SCHEMA ff_side`,
        `CREATE VIEW ff_side.everyone AS SELECT id FROM public.tenants`,
        `ALTER VIEW ff_side.everyone OWNER TO ${SYSTEM_ROLE}`,
      ],
      /service role flowforge_system owns or has rights on view ff_side.everyone/,
    ],
  ])('refuses %s added after the deployment', async (_case, drift, problem) => {
    const ds = await freshScratch();
    await migrate(ds);
    for (const sql of drift) await ds.query(sql);
    await expect(migrate(ds)).rejects.toThrow(problem);
  });

  it('accepts an extra object of the migration owner that grants nothing to anyone', async () => {
    const ds = await freshScratch();
    await migrate(ds);
    await ds.query(
      `CREATE FUNCTION public.ff_owner_only() RETURNS integer LANGUAGE sql AS 'SELECT 1'`,
    );
    await ds.query(`REVOKE ALL ON FUNCTION public.ff_owner_only() FROM PUBLIC`);
    await expect(migrate(ds)).resolves.toEqual([]);
  });

  // Наявна службова роль, що може входити, не «лагодиться» в NOLOGIN: до COMMIT вона ще пускала б
  // нові сесії, і ті отримали б BYPASSRLS. Атрибут змінено лише в транзакції тесту (відкочується),
  // тож кластер не бачить ролі з входом ні на мить.
  it('refuses a service role that can log in instead of repairing it', async () => {
    const ds = await freshScratch();
    const runner = ds.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query(`ALTER ROLE ${SYSTEM_ROLE} LOGIN`);
      const executor = new MigrationExecutor(ds, runner);
      executor.transaction = 'none';
      await expect(executor.executePendingMigrations()).rejects.toThrow(
        `service role ${SYSTEM_ROLE} has unexpected attributes`,
      );
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  });
});
