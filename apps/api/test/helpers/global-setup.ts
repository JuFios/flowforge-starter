import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../../src/database/database.options';
import { migrate } from '../../src/database/migrate';
import {
  generateTestRolePasswords,
  testDatabaseEnv,
  testDatabaseUrl,
} from './test-env';
import freshTransformBuild from './fresh-transform-build';
import { provisionTestDatabase } from './test-provision';

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
  freshTransformBuild();
  const url = testDatabaseUrl();
  // До будь-якого тестового процесу: jest запускає їх уже з цим оточенням.
  generateTestRolePasswords();
  await ensureDatabaseExists(url);
  // Як CLI міграцій: без statement_timeout.
  const ds = new DataSource(
    buildDataSourceOptions(testDatabaseEnv(), { statementTimeout: false }),
  );
  await ds.initialize();
  try {
    await ds.query('DROP SCHEMA IF EXISTS public CASCADE');
    await ds.query('CREATE SCHEMA public');
    // Тим самим шляхом, що й `db:migrate` у compose: одна транзакція й звірка інваріантів безпеки.
    await migrate(ds);
    // Як db:provision у compose: застосунок у тестах ходить runtime-ролями без BYPASSRLS.
    await provisionTestDatabase((sql, params) => ds.query(sql, params));
  } finally {
    await ds.destroy();
  }
}
