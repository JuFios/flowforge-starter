import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../../src/database/database.options';
import { testDatabaseEnv } from './test-env';
import { dropTestLoginRoles } from './test-provision';

/**
 * Один раз після всіх інтеграційних тестів: login-ролі тестів видаляються, тож після прогону на
 * спільному кластері не лишається логінів із паролем (навіть випадковим).
 */
export default async function globalTeardown(): Promise<void> {
  const ds = new DataSource(
    buildDataSourceOptions(testDatabaseEnv(), { statementTimeout: false }),
  );
  await ds.initialize();
  try {
    await dropTestLoginRoles((sql, params) => ds.query(sql, params));
  } finally {
    await ds.destroy();
  }
}
