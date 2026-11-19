import {
  limitDefaultsFromEnv,
  provisionLimitDefaults,
  provisionLoginRoles,
  Query,
} from '../../src/database/provision';
import { API_ROLE, WORKER_ROLE } from '../../src/tenancy/roles';
import {
  TEST_API_DB_PASSWORD,
  TEST_API_DB_USER,
  TEST_WORKER_DB_PASSWORD,
  TEST_WORKER_DB_USER,
} from './test-env';

/**
 * Те саме, що db:provision у compose, для тестової БД: login-ролі застосунку (без BYPASSRLS) і
 * значення лімітів за замовчуванням. Викликається після побудови схеми й після кожного тесту, що
 * перезастосовує міграції (міграція TenantUsage засіває вбудовані значення заново).
 */
export async function provisionTestDatabase(query: Query): Promise<void> {
  await provisionLoginRoles(query, [
    { user: TEST_API_DB_USER, password: TEST_API_DB_PASSWORD, group: API_ROLE },
    {
      user: TEST_WORKER_DB_USER,
      password: TEST_WORKER_DB_PASSWORD,
      group: WORKER_ROLE,
    },
  ]);
  // Наявні тести черги захоплюють десятки задач одного тенанта без завершення: ліміт задач у
  // роботі для них — вище; тести лімітів задають ліміти тенанта явно.
  await provisionLimitDefaults(
    query,
    limitDefaultsFromEnv({ TENANT_MAX_RUNNING: '1000' }),
  );
}
