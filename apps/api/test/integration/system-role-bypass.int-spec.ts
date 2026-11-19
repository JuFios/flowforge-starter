import { DataSource } from 'typeorm';
import { assertRolesUnclaimed } from '../../src/tenancy/login-role-check';
import { SYSTEM_ROLE } from '../../src/tenancy/roles';
import { openTestDataSource } from '../helpers/db';
import { clusterScopedName, testDatabaseUrl } from '../helpers/test-env';

/** Інша БД того самого кластера з пасткою, що належить системній ролі. */
const TRAP_DB = clusterScopedName('ff_bypass_trap_test');
/** Порожня БД, яку мігрують: у ній системна роль ще нічим не володіє. */
const TARGET_DB = clusterScopedName('ff_bypass_target_test');

/**
 * BYPASSRLS — атрибут ролі, а не БД: його надання `flowforge_system` діє в кожній БД кластера.
 * SECURITY DEFINER-функція цієї ролі в іншій БД, створена заздалегідь, після першого надання
 * читала б рядки поза політикою, тож перед першим наданням власність перевіряється по кластеру.
 */
describe('the first BYPASSRLS grant to flowforge_system', () => {
  let owner: DataSource;
  let target: DataSource;

  function urlOf(database: string): string {
    const url = new URL(testDatabaseUrl());
    url.pathname = `/${database}`;
    return url.toString();
  }

  beforeAll(async () => {
    owner = await openTestDataSource();
    for (const db of [TRAP_DB, TARGET_DB]) {
      await owner.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      await owner.query(`CREATE DATABASE ${db}`);
    }
    const trap = await new DataSource({
      type: 'postgres',
      url: urlOf(TRAP_DB),
    }).initialize();
    try {
      await trap.query(`CREATE TABLE secrets (value text)`);
      await trap.query(`INSERT INTO secrets VALUES ('hidden')`);
      await trap.query(`ALTER TABLE secrets ENABLE ROW LEVEL SECURITY`);
      await trap.query(`ALTER TABLE secrets FORCE ROW LEVEL SECURITY`);
      await trap.query(`CREATE POLICY nobody ON secrets USING (false)`);
      await trap.query(`GRANT SELECT ON secrets TO ${SYSTEM_ROLE}`);
      await trap.query(
        `CREATE FUNCTION leak() RETURNS SETOF text LANGUAGE sql SECURITY DEFINER
           SET search_path = pg_catalog, public AS $$ SELECT value FROM public.secrets $$`,
      );
      await trap.query(`ALTER FUNCTION leak() OWNER TO ${SYSTEM_ROLE}`);
    } finally {
      await trap.destroy();
    }
    target = await new DataSource({
      type: 'postgres',
      url: urlOf(TARGET_DB),
    }).initialize();
  });

  afterAll(async () => {
    await target?.destroy();
    for (const db of [TRAP_DB, TARGET_DB])
      await owner.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await owner.destroy();
  });

  /** Перевірка в транзакції, де роль ще без BYPASSRLS (відкочується, кластер не змінюється). */
  async function checkBeforeFirstGrant(): Promise<void> {
    const runner = target.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query(`ALTER ROLE ${SYSTEM_ROLE} NOBYPASSRLS`);
      await assertRolesUnclaimed((sql, params) => runner.query(sql, params));
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  }

  it('refuses it while the role owns objects in another database of the cluster', async () => {
    await expect(checkBeforeFirstGrant()).rejects.toThrow(
      new RegExp(
        `${SYSTEM_ROLE} already owns objects in other databases of this cluster: .*\\b${TRAP_DB}\\b`,
      ),
    );
  });

  it('accepts them once the role already bypasses RLS: the grant changes nothing in the cluster', async () => {
    await expect(
      assertRolesUnclaimed((sql, params) => target.query(sql, params)),
    ).resolves.toBeUndefined();
  });
});
