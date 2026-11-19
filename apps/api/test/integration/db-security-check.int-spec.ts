import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AppModule, WorkerModule } from '../../src/app.module';
import { RUNTIME_DATABASE_URL } from '../../src/database/runtime-database-url';
import {
  DatabaseSecurityCheck,
  ProcessKind,
} from '../../src/tenancy/database-security.check';
import { WORKER_ROLE } from '../../src/tenancy/roles';
import { startApp } from '../helpers/app';
import { openTestDataSource } from '../helpers/db';
import {
  clusterScopedName,
  TEST_API_DB_USER,
  testApiDatabaseUrl,
  testDatabaseUrl,
  testRoleUrl,
  testWorkerDatabaseUrl,
} from '../helpers/test-env';

/** Допоміжні ролі сценаріїв (спільні для кластера, тож з суфіксом прогону). */
const FOREIGN_ROLE = clusterScopedName('ff_foreign_test');
const BYPASS_GROUP = clusterScopedName('test_bypass_group');

/**
 * Процес не стартує з роллю, що обходить RLS або належить іншому процесу: помилкова конфігурація
 * не може тихо вимкнути ізоляцію тенантів.
 */
describe('database role check at startup', () => {
  let owner: DataSource;

  beforeAll(async () => {
    owner = await openTestDataSource();
  });

  afterAll(async () => {
    await owner.destroy();
  });

  async function problems(url: string, kind: ProcessKind): Promise<string[]> {
    const ds = await new DataSource({ type: 'postgres', url }).initialize();
    try {
      return await new DatabaseSecurityCheck(ds, kind).findProblems();
    } finally {
      await ds.destroy();
    }
  }

  it('accepts each process with its own role', async () => {
    expect(await problems(testApiDatabaseUrl(), 'api')).toEqual([]);
    expect(await problems(testWorkerDatabaseUrl(), 'worker')).toEqual([]);
  });

  it('rejects the schema owner (a superuser)', async () => {
    const found = await problems(testDatabaseUrl(), 'api');
    expect(found).toEqual(
      expect.arrayContaining([
        'the role is a superuser',
        'the role has BYPASSRLS',
      ]),
    );
  });

  it('rejects the role of the other process', async () => {
    expect(await problems(testWorkerDatabaseUrl(), 'api')).toEqual(
      expect.arrayContaining([
        'the role is not a member of flowforge_api_role',
        'the role is a member of flowforge_worker_role, which belongs to the other process',
      ]),
    );
    expect(await problems(testApiDatabaseUrl(), 'worker')).toEqual(
      expect.arrayContaining([
        'the role is not a member of flowforge_worker_role',
      ]),
    );
  });

  it('rejects a role that can act as a BYPASSRLS role', async () => {
    await owner.query(`CREATE ROLE ${BYPASS_GROUP} NOLOGIN BYPASSRLS`);
    await owner.query(`GRANT ${BYPASS_GROUP} TO ${TEST_API_DB_USER}`);
    try {
      expect(await problems(testApiDatabaseUrl(), 'api')).toContain(
        `the role can act as the privileged role ${BYPASS_GROUP}`,
      );
    } finally {
      await owner.query(`REVOKE ${BYPASS_GROUP} FROM ${TEST_API_DB_USER}`);
      await owner.query(`DROP ROLE ${BYPASS_GROUP}`);
    }
  });

  // Власник, що стартує сесію з role=<runtime-роль>, виглядає як runtime-роль, але будь-який
  // RESET ROLE повертає йому права суперкористувача.
  it('rejects the schema owner acting as the runtime role from the connection options', async () => {
    const url = new URL(testDatabaseUrl());
    url.searchParams.set('options', `-c role=${TEST_API_DB_USER}`);
    const ds = await new DataSource({
      type: 'postgres',
      url: url.toString(),
    }).initialize();
    try {
      const [{ me }]: Array<{ me: string }> = await ds.query(
        'SELECT current_user AS me',
      );
      expect(me).toBe(TEST_API_DB_USER);
      expect(
        await new DatabaseSecurityCheck(ds, 'api').findProblems(),
      ).toContain(
        'the session runs as another role than it authenticated with',
      );
    } finally {
      await ds.destroy();
    }
  });

  // Член службової ролі сам виставляє app.tenant_id (або обходить RLS як flowforge_system):
  // така роль поруч — обхід ізоляції, навіть якщо роль самого процесу безпечна.
  it.each([
    [
      'a foreign member of flowforge_system',
      `CREATE ROLE ${FOREIGN_ROLE} NOLOGIN`,
      `GRANT flowforge_system TO ${FOREIGN_ROLE}`,
      `unexpected member ${FOREIGN_ROLE} of flowforge_system`,
    ],
    [
      'an administrator of the other process group',
      `CREATE ROLE ${FOREIGN_ROLE} LOGIN`,
      `GRANT flowforge_worker_role TO ${FOREIGN_ROLE} WITH ADMIN OPTION`,
      `unexpected member ${FOREIGN_ROLE} of flowforge_worker_role`,
    ],
  ])('rejects %s', async (_case, create, grant, problem) => {
    await owner.query(create);
    try {
      await owner.query(grant);
      expect(await problems(testApiDatabaseUrl(), 'api')).toContain(problem);
    } finally {
      await owner.query(`DROP ROLE ${FOREIGN_ROLE}`);
    }
  });

  // Службова функція чужого процесу через груповий грант чи PUBLIC: API забирав би задачі воркера
  // чи видаляв історію всіх тенантів, хоча RLS і права на таблиці правильні.
  it.each<[string, ProcessKind, string, string]>([
    [
      'claim_job granted to the API group',
      'api',
      'GRANT EXECUTE ON FUNCTION claim_job(text,integer) TO flowforge_api_role',
      'REVOKE EXECUTE ON FUNCTION claim_job(text,integer) FROM flowforge_api_role',
    ],
    [
      'purge_execution_history granted to PUBLIC',
      'api',
      'GRANT EXECUTE ON FUNCTION purge_execution_history(integer,integer) TO PUBLIC',
      'REVOKE EXECUTE ON FUNCTION purge_execution_history(integer,integer) FROM PUBLIC',
    ],
    [
      'lock_tenant_usage granted to the worker group',
      'worker',
      'GRANT EXECUTE ON FUNCTION lock_tenant_usage() TO flowforge_worker_role',
      'REVOKE EXECUTE ON FUNCTION lock_tenant_usage() FROM flowforge_worker_role',
    ],
    [
      'a usage trigger function granted to the worker group',
      'worker',
      'GRANT EXECUTE ON FUNCTION tenant_usage_on_job() TO flowforge_worker_role',
      'REVOKE EXECUTE ON FUNCTION tenant_usage_on_job() FROM flowforge_worker_role',
    ],
  ])('rejects %s', async (_case, kind, grant, revoke) => {
    const url = kind === 'api' ? testApiDatabaseUrl() : testWorkerDatabaseUrl();
    expect(await problems(url, kind)).toEqual([]);
    await owner.query(grant);
    try {
      expect(await problems(url, kind)).toContain(
        'unexpected runtime group privileges',
      );
    } finally {
      await owner.query(revoke);
    }
  });

  it('rejects a reachable SECURITY DEFINER function of a bypassing owner outside public', async () => {
    await owner.query('CREATE SCHEMA ff_side_test');
    try {
      await owner.query(
        `CREATE FUNCTION ff_side_test.peek() RETURNS bigint LANGUAGE sql SECURITY DEFINER
           SET search_path = pg_catalog AS $$ SELECT count(*) FROM public.jobs $$`,
      );
      await owner.query(
        'ALTER FUNCTION ff_side_test.peek() OWNER TO flowforge_system',
      );
      await owner.query(
        'GRANT USAGE ON SCHEMA ff_side_test TO flowforge_api_role',
      );
      expect(await problems(testApiDatabaseUrl(), 'api')).toContain(
        'unexpected runtime group privileges',
      );
    } finally {
      await owner.query('DROP SCHEMA ff_side_test CASCADE');
    }
  });

  it('rejects a column-only grant on an unprotected table', async () => {
    await owner.query('CREATE TABLE column_check (value int)');
    try {
      await owner.query(
        'GRANT SELECT(value) ON column_check TO flowforge_api_role',
      );
      expect(await problems(testApiDatabaseUrl(), 'api')).toContain(
        'table column_check is accessible without forced row-level security',
      );
    } finally {
      await owner.query('DROP TABLE column_check');
    }
  });

  it('rejects a reachable table without forced row-level security', async () => {
    await owner.query(`CREATE TABLE test_unprotected (id int)`);
    await owner.query(`GRANT SELECT ON test_unprotected TO flowforge_api_role`);
    try {
      expect(await problems(testApiDatabaseUrl(), 'api')).toContain(
        'table test_unprotected is accessible without forced row-level security',
      );
      // Політика без FORCE не рахується: власник таблиці обходив би її.
      await owner.query(
        `ALTER TABLE test_unprotected ENABLE ROW LEVEL SECURITY`,
      );
      await owner.query(`CREATE POLICY p ON test_unprotected USING (true)`);
      expect(await problems(testApiDatabaseUrl(), 'api')).toContain(
        'table test_unprotected is accessible without forced row-level security',
      );
    } finally {
      await owner.query(`DROP TABLE test_unprotected`);
    }
  });

  // Інваріанти каталогу на старті: дрейф після розгортання будь-якої ролі, не лише групи процесу.
  it.each([
    [
      'EXECUTE on claim_job for a foreign role',
      [
        `CREATE ROLE ${FOREIGN_ROLE} NOLOGIN`,
        `GRANT EXECUTE ON FUNCTION claim_job(text, integer) TO ${FOREIGN_ROLE}`,
      ],
      [
        `REVOKE EXECUTE ON FUNCTION claim_job(text, integer) FROM ${FOREIGN_ROLE}`,
        `DROP ROLE ${FOREIGN_ROLE}`,
      ],
      new RegExp(
        `function claim_job\\(text,integer\\) grants ${FOREIGN_ROLE} EXECUTE`,
      ),
    ],
    [
      'an extra permissive policy',
      [`CREATE POLICY open_read ON executions FOR SELECT USING (true)`],
      [`DROP POLICY open_read ON executions`],
      /unexpected policy open_read on table executions/,
    ],
  ])(
    'rejects catalog drift after migrations: %s',
    async (_case, drift, undo, problem) => {
      try {
        for (const sql of drift) await owner.query(sql);
        for (const kind of ['api', 'worker'] as const)
          expect(
            await problems(
              kind === 'api' ? testApiDatabaseUrl() : testWorkerDatabaseUrl(),
              kind,
            ),
          ).toEqual(expect.arrayContaining([expect.stringMatching(problem)]));
      } finally {
        for (const sql of undo) await owner.query(sql).catch(() => undefined);
      }
    },
  );

  // Сесія, відкрита під службовою роллю, поки та ще мала LOGIN, переживає зняття LOGIN. Пароль
  // випадковий і діє лише кілька мілісекунд, роль воркера не має BYPASSRLS.
  it('rejects an open session of a service role', async () => {
    const password = randomBytes(24).toString('hex');
    await owner.query(`ALTER ROLE ${WORKER_ROLE} LOGIN PASSWORD '${password}'`);
    const openSession = async (): Promise<DataSource> => {
      try {
        return await new DataSource({
          type: 'postgres',
          // Інша БД кластера: сесії службових ролей звіряються в усьому кластері, а CONNECT до
          // тестової БД має лише login-роль процесу.
          url: Object.assign(new URL(testRoleUrl(WORKER_ROLE, password)), {
            pathname: '/postgres',
          }).toString(),
        }).initialize();
      } finally {
        await owner.query(`ALTER ROLE ${WORKER_ROLE} NOLOGIN PASSWORD NULL`);
      }
    };
    const session = await openSession();
    try {
      expect(await problems(testApiDatabaseUrl(), 'api')).toContain(
        `service role ${WORKER_ROLE} has open sessions`,
      );
    } finally {
      await session.destroy();
    }
  });

  it.each([
    ['API', AppModule],
    ['worker', WorkerModule],
  ])(
    'refuses to start the %s connected as the schema owner',
    async (_name, module) => {
      await expect(
        startApp(module).then(async (app) => {
          await app.close();
          return 'started';
        }),
      ).resolves.toBe('started');
      await expect(startOverridden(module, testDatabaseUrl())).rejects.toThrow(
        /database role is not safe .*superuser/s,
      );
    },
  );
});

/** Запуск модуля з іншою адресою БД (провайдер RUNTIME_DATABASE_URL). */
async function startOverridden(
  module: typeof AppModule | typeof WorkerModule,
  url: string,
): Promise<void> {
  const { Test } = await import('@nestjs/testing');
  const moduleRef = await Test.createTestingModule({ imports: [module] })
    .overrideProvider(RUNTIME_DATABASE_URL)
    .useValue(url)
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  try {
    await app.init();
  } finally {
    await app.close();
  }
}
