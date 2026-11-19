import { DataSource } from 'typeorm';
import { AppModule, WorkerModule } from '../../src/app.module';
import { RUNTIME_DATABASE_URL } from '../../src/database/runtime-database-url';
import {
  DatabaseSecurityCheck,
  ProcessKind,
} from '../../src/tenancy/database-security.check';
import { startApp } from '../helpers/app';
import { openTestDataSource } from '../helpers/db';
import {
  TEST_API_DB_USER,
  testApiDatabaseUrl,
  testDatabaseUrl,
  testWorkerDatabaseUrl,
} from '../helpers/test-env';

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
    await owner.query(`CREATE ROLE test_bypass_group NOLOGIN BYPASSRLS`);
    await owner.query(`GRANT test_bypass_group TO ${TEST_API_DB_USER}`);
    try {
      expect(await problems(testApiDatabaseUrl(), 'api')).toContain(
        'the role can act as the privileged role test_bypass_group',
      );
    } finally {
      await owner.query(`REVOKE test_bypass_group FROM ${TEST_API_DB_USER}`);
      await owner.query(`DROP ROLE test_bypass_group`);
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
