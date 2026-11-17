import { DataSourceOptions } from 'typeorm';
import type { DatabaseEnvironment } from '../config/env.validation';
import { Execution, Job, StepRun, Tenant, Workflow } from '../entities';
import { MIGRATIONS } from './migrations';

export const ENTITIES = [Tenant, Workflow, Execution, StepRun, Job];

/**
 * Запас клієнтського query_timeout понад statement_timeout: спершу запит скасовує сервер (з
 * кодом 57014), а клієнт здається сам, лише якщо відповідь не прийшла взагалі (мережа, завислий
 * сервер).
 */
export const QUERY_TIMEOUT_GRACE_MS = 5_000;

export interface DataSourceBuildOptions {
  /**
   * Обмежувати тривалість запитів (statement_timeout, idle_in_transaction_session_timeout,
   * клієнтський query_timeout). Вимикається лише для CLI міграцій: зміна схеми великої таблиці
   * легітимно триває довше за запит застосунку. Таймаут з'єднання діє завжди.
   */
  statementTimeout?: boolean;
}

/**
 * Єдине джерело налаштувань підключення: використовується Nest-модулем,
 * CLI міграцій (data-source.ts) та інтеграційними тестами.
 *
 * Схема змінюється лише міграціями: synchronize вимкнено, а міграції
 * запускаються окремим кроком до старту API/воркерів.
 */
export function buildDataSourceOptions(
  db: Pick<DatabaseEnvironment, 'DATABASE_URL' | 'DB_CONNECT_TIMEOUT_MS' | 'DB_STATEMENT_TIMEOUT_MS'>,
  { statementTimeout = true }: DataSourceBuildOptions = {},
): DataSourceOptions {
  const statementMs = db.DB_STATEMENT_TIMEOUT_MS;
  return {
    type: 'postgres',
    url: db.DATABASE_URL,
    // Без нього pg чекає встановлення з'єднання необмежено (сервер прийняв TCP і мовчить).
    connectTimeoutMS: db.DB_CONNECT_TIMEOUT_MS,
    extra: statementTimeout
      ? {
          statement_timeout: statementMs,
          idle_in_transaction_session_timeout: statementMs,
          query_timeout: statementMs + QUERY_TIMEOUT_GRACE_MS,
        }
      : {},
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
