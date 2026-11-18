import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../../src/database/database.options';
import { provisionLoginRoles } from '../../src/database/provision';
import { API_ROLE, WORKER_ROLE } from '../../src/tenancy/roles';
import {
  TEST_API_DB_PASSWORD,
  TEST_API_DB_USER,
  TEST_WORKER_DB_PASSWORD,
  TEST_WORKER_DB_USER,
  testDatabaseEnv,
  testDatabaseUrl,
} from './test-env';

async function ensureDatabaseExists(url: string): Promise<void> {
  const target = new URL(url);
  const dbName = target.pathname.replace(/^\//, '');
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const ds = await new DataSource({
    type: 'postgres',
    url: admin.toString(),
  }).initialize();
  try {
    const rows: unknown[] = await ds.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [dbName],
    );
    if (rows.length === 0)
      await ds.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
  } finally {
    await ds.destroy();
  }
}

/**
 * Один раз перед усіма інтеграційними тестами: тестова БД очищається повністю
 * і схема будується лише міграціями — так кожен прогін перевіряє міграції з нуля. Підключення —
 * власником схеми (суперкористувачем), як крок міграцій у compose.
 */
export default async function globalSetup(): Promise<void> {
  const url = testDatabaseUrl();
  await ensureDatabaseExists(url);
  // Як CLI міграцій: без statement_timeout.
  const ds = new DataSource(
    buildDataSourceOptions(testDatabaseEnv(), { statementTimeout: false }),
  );
  await ds.initialize();
  try {
    await ds.query('DROP SCHEMA IF EXISTS public CASCADE');
    await ds.query('CREATE SCHEMA public');
    await ds.runMigrations({ transaction: 'each' });
    // Як db:provision у compose: застосунок у тестах ходить runtime-ролями без BYPASSRLS.
    await provisionLoginRoles(
      (sql, params) => ds.query(sql, params),
      [
        {
          user: TEST_API_DB_USER,
          password: TEST_API_DB_PASSWORD,
          group: API_ROLE,
        },
        {
          user: TEST_WORKER_DB_USER,
          password: TEST_WORKER_DB_PASSWORD,
          group: WORKER_ROLE,
        },
      ],
    );
  } finally {
    await ds.destroy();
  }
}
