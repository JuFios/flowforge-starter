import { DataSourceOptions } from 'typeorm';
import { Execution, Job, StepRun, Tenant, Workflow } from '../entities';
import { MIGRATIONS } from './migrations';

export const ENTITIES = [Tenant, Workflow, Execution, StepRun, Job];

/**
 * Єдине джерело налаштувань підключення: використовується Nest-модулем,
 * CLI міграцій (data-source.ts) та інтеграційними тестами.
 *
 * Схема змінюється лише міграціями: synchronize вимкнено, а міграції
 * запускаються окремим кроком до старту API/воркерів.
 */
export function buildDataSourceOptions(url: string): DataSourceOptions {
  return {
    type: 'postgres',
    url,
    entities: ENTITIES,
    migrations: MIGRATIONS,
    migrationsTableName: 'migrations',
    synchronize: false,
    migrationsRun: false,
    // gen_random_uuid() вбудована в Postgres 13+, розширення не потрібні:
    // застосунок не мусить мати прав на CREATE EXTENSION.
    uuidExtension: 'pgcrypto',
    installExtensions: false,
  };
}
