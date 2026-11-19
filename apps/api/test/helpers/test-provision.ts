import { DataSource } from 'typeorm';
import {
  limitDefaultsFromEnv,
  provisionLimitDefaults,
  provisionLoginRoles,
  Query,
} from '../../src/database/provision';
import { API_ROLE, WORKER_ROLE } from '../../src/tenancy/roles';
import {
  TEST_API_DB_USER,
  TEST_WORKER_DB_USER,
  testRolePassword,
} from './test-env';

/**
 * Те саме, що db:provision у compose, для тестової БД: login-ролі застосунку (без BYPASSRLS) і
 * значення лімітів за замовчуванням. Викликається після побудови схеми й після кожного тесту, що
 * перезастосовує міграції (міграція TenantUsage засіває вбудовані значення заново).
 */
export async function provisionTestDatabase(ds: DataSource): Promise<void> {
  await ds.transaction(async (em) => {
    const query: Query = (sql, params) => em.query(sql, params);
    await provisionLoginRoles(query, [
      {
        user: TEST_API_DB_USER,
        password: testRolePassword(TEST_API_DB_USER),
        group: API_ROLE,
      },
      {
        user: TEST_WORKER_DB_USER,
        password: testRolePassword(TEST_WORKER_DB_USER),
        group: WORKER_ROLE,
      },
    ]);
    // Наявні тести черги захоплюють десятки задач одного тенанта без завершення: ліміт задач у
    // роботі для них — вище; тести лімітів задають ліміти тенанта явно.
    await provisionLimitDefaults(
      query,
      limitDefaultsFromEnv({ TENANT_MAX_RUNNING: '1000' }),
    );
  });
}

/**
 * Видаляє login-ролі тестів: їхні права в тестовій БД (CONNECT) і самі ролі. Ролі db:provision
 * нічим не володіють, тож DROP OWNED прибирає лише гранти. Роль, якої немає, пропускається.
 */
export async function dropTestLoginRoles(query: Query): Promise<void> {
  for (const user of [TEST_API_DB_USER, TEST_WORKER_DB_USER]) {
    const rows = (await query(
      'SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1',
      [user],
    )) as unknown[];
    if (!rows.length) continue;
    await query(`DROP OWNED BY "${user}"`);
    await query(`DROP ROLE "${user}"`);
  }
}
