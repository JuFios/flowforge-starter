import { createHash, randomBytes } from 'node:crypto';
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
 * Ім'я спільного для кластера об'єкта тестів (login-роль, допоміжна роль, тимчасова БД) з суфіксом
 * від імені тестової БД. Ролі й бази Postgres спільні для кластера, тож два прогони з різними
 * `TEST_DATABASE_URL` на одному кластері інакше ділили б їх: один змінив би пароль чи видалив би
 * роль іншого. Суфікс сталий для однієї БД, тож teardown знаходить залишки прогону, що впав.
 * Обчислюється один раз під час завантаження модуля: усі імена прогону — від однієї БД.
 */
const RUN_SUFFIX = createHash('sha256')
  .update(new URL(testDatabaseUrl()).pathname.replace(/^\//, ''))
  .digest('hex')
  .slice(0, 8);

export function clusterScopedName(base: string): string {
  if (!/^[a-z_][a-z0-9_]{0,50}$/.test(base))
    throw new Error(`invalid cluster-wide test name base "${base}"`);
  return `${base}_${RUN_SUFFIX}`;
}

/**
 * Runtime-ролі тестів: окремі імена від ролей compose і від інших тестових прогонів на тому самому
 * кластері (`clusterScopedName`), бо групові й login-ролі спільні для кластера Postgres.
 */
export const TEST_API_DB_USER = clusterScopedName('flowforge_api_test');
export const TEST_WORKER_DB_USER = clusterScopedName('flowforge_worker_test');

/**
 * Паролі runtime-ролей тестів — випадкові на кожен прогін: global setup генерує їх і передає
 * тестовим процесам через оточення, global teardown видаляє ролі. Відомий з репозиторію пароль
 * лишав би на спільному кластері логін, яким будь-хто підключився б до БД із CONNECT для PUBLIC.
 */
const PASSWORD_ENV: Readonly<Record<string, string>> = {
  [TEST_API_DB_USER]: 'FLOWFORGE_TEST_API_DB_PASSWORD',
  [TEST_WORKER_DB_USER]: 'FLOWFORGE_TEST_WORKER_DB_PASSWORD',
};

/** Нові випадкові паролі ролей тестів (у оточенні поточного процесу й його нащадків). */
export function generateTestRolePasswords(): void {
  for (const name of Object.values(PASSWORD_ENV))
    process.env[name] = randomBytes(24).toString('hex');
}

/** Пароль ролі тестів поточного прогону; без global setup — помилка, а не відомий пароль. */
export function testRolePassword(user: string): string {
  const variable = PASSWORD_ENV[user];
  if (!variable) throw new Error(`${user} is not a runtime role of the tests`);
  const password = process.env[variable];
  if (!password)
    throw new Error(
      `${variable} is not set: integration tests generate it in their global setup`,
    );
  return password;
}

/** Адреса тестової БД з обліковими даними іншої ролі. */
export function testRoleUrl(user: string, password: string): string {
  const url = new URL(testDatabaseUrl());
  url.username = user;
  url.password = password;
  return url.toString();
}

/** Роль процесу API (flowforge_api_role, без BYPASSRLS). */
export function testApiDatabaseUrl(): string {
  return testRoleUrl(TEST_API_DB_USER, testRolePassword(TEST_API_DB_USER));
}

/** Роль процесу воркера (flowforge_worker_role, без BYPASSRLS). */
export function testWorkerDatabaseUrl(): string {
  return testRoleUrl(
    TEST_WORKER_DB_USER,
    testRolePassword(TEST_WORKER_DB_USER),
  );
}
