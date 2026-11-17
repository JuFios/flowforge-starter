import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadDotEnvIfPresent } from './cli-env';
import { buildDataSourceOptions } from './database.options';

/** DataSource для TypeORM CLI (migration:run / revert / generate). */
loadDotEnvIfPresent();
const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL is required to run migrations (set it in the environment or in .env)');
}

export default new DataSource(buildDataSourceOptions(url));
