import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { validateDatabaseEnv } from '../config/env.validation';
import { loadDotEnvIfPresent } from './cli-env';
import { buildDataSourceOptions } from './database.options';

/**
 * DataSource для TypeORM CLI (migration:run / revert / generate). Міграції виконує власник схеми —
 * суперкористувач Postgres (MIGRATION_DATABASE_URL), а не runtime-роль API чи воркера (DATABASE_URL).
 */
loadDotEnvIfPresent();
if (!process.env.MIGRATION_DATABASE_URL) {
  throw new Error(
    'MIGRATION_DATABASE_URL is required to run migrations: the URL of the schema owner (a PostgreSQL superuser)',
  );
}

// Таймаут з'єднання — як у застосунку; statement_timeout для міграцій не діє (довгі ALTER TABLE).
export default new DataSource(
  buildDataSourceOptions(
    validateDatabaseEnv({
      ...process.env,
      DATABASE_URL: process.env.MIGRATION_DATABASE_URL,
    }),
    { statementTimeout: false },
  ),
);
