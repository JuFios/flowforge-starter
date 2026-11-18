import {
  DatabaseEnvironment,
  validateDatabaseEnv,
} from '../../src/config/env.validation';

/** Адреса тестової БД. Окрема база, яку глобальний setup очищає й мігрує з нуля. */
export const DEFAULT_TEST_DATABASE_URL =
  'postgres://flowforge:flowforge@localhost:5432/flowforge_test';

export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
  const dbName = new URL(url).pathname.replace(/^\//, '');
  // Захист від випадкового запуску на робочій БД: setup видаляє схему public.
  if (!dbName.endsWith('_test')) {
    throw new Error(
      `TEST_DATABASE_URL має вказувати на базу з суфіксом _test, отримано "${dbName}"`,
    );
  }
  return url;
}

/** Змінні підключення до тестової БД з тими самими значеннями за замовчуванням, що й у застосунку. */
export function testDatabaseEnv(): DatabaseEnvironment {
  return validateDatabaseEnv({ DATABASE_URL: testDatabaseUrl() });
}

export const TEST_ADMIN_TOKEN = 'test-admin-token-0123456789';

/**
 * Runtime-ролі тестів: окремі імена від ролей compose, бо групові й login-ролі спільні для
 * кластера Postgres, а тестовий прогін не повинен змінювати паролі робочих ролей поруч.
 */
export const TEST_API_DB_USER = 'flowforge_api_test';
export const TEST_WORKER_DB_USER = 'flowforge_worker_test';
export const TEST_API_DB_PASSWORD = 'testApiRolePassword0123456789';
export const TEST_WORKER_DB_PASSWORD = 'testWorkerRolePassword0123456789';

/** Адреса тестової БД з обліковими даними іншої ролі. */
export function testRoleUrl(user: string, password: string): string {
  const url = new URL(testDatabaseUrl());
  url.username = user;
  url.password = password;
  return url.toString();
}

/** Роль процесу API (flowforge_api_role, без BYPASSRLS). */
export function testApiDatabaseUrl(): string {
  return testRoleUrl(TEST_API_DB_USER, TEST_API_DB_PASSWORD);
}

/** Роль процесу воркера (flowforge_worker_role, без BYPASSRLS). */
export function testWorkerDatabaseUrl(): string {
  return testRoleUrl(TEST_WORKER_DB_USER, TEST_WORKER_DB_PASSWORD);
}
