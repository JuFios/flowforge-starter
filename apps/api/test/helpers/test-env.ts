/** Адреса тестової БД. Окрема база, яку глобальний setup очищає й мігрує з нуля. */
export const DEFAULT_TEST_DATABASE_URL = 'postgres://flowforge:flowforge@localhost:5432/flowforge_test';

export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
  const dbName = new URL(url).pathname.replace(/^\//, '');
  // Захист від випадкового запуску на робочій БД: setup видаляє схему public.
  if (!dbName.endsWith('_test')) {
    throw new Error(`TEST_DATABASE_URL має вказувати на базу з суфіксом _test, отримано "${dbName}"`);
  }
  return url;
}

export const TEST_ADMIN_TOKEN = 'test-admin-token-0123456789';
