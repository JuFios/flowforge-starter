import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from './database.options';

/** DataSource для TypeORM CLI (migration:run / revert / generate). */
const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL is required to run migrations');
}

export default new DataSource(buildDataSourceOptions(url));
