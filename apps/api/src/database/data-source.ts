import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { validateDatabaseEnv } from '../config/env.validation';
import { loadDotEnvIfPresent } from './cli-env';
import { buildDataSourceOptions } from './database.options';

/** DataSource для TypeORM CLI (migration:run / revert / generate). */
loadDotEnvIfPresent();
if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is required to run migrations (set it in the environment or in .env)',
  );
}

// Таймаут з'єднання — як у застосунку; statement_timeout для міграцій не діє (довгі ALTER TABLE).
export default new DataSource(
  buildDataSourceOptions(validateDatabaseEnv(process.env), {
    statementTimeout: false,
  }),
);
