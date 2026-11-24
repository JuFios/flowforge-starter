import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PgListener } from '../common/pg-listener';
import { EnvironmentVariables } from '../config/env.validation';
import { RUNTIME_DATABASE_URL } from '../database/runtime-database-url';

/** Канал підказки про нову готову задачу (міграція WorkReadySignals). */
export const JOBS_READY = 'ff_jobs_ready';
/** Канал підказки про нову подію, яку вже можна надсилати. */
export const OUTBOX_READY = 'ff_outbox_ready';

/**
 * `LISTEN` воркера на підказки про нову готову роботу (docs/architecture.md, «Пробудження
 * воркера»). Одне з'єднання поза пулом на процес; підказка лише перериває паузу опитування одного
 * циклу, а без з'єднання цикли опитують чергу, як і раніше.
 */
@Injectable()
export class WorkSignals extends PgListener implements OnApplicationShutdown {
  constructor(
    config: ConfigService<EnvironmentVariables, true>,
    @Inject(RUNTIME_DATABASE_URL) databaseUrl: string,
  ) {
    super(
      () => ({
        connectionString: databaseUrl,
        channels: [JOBS_READY, OUTBOX_READY],
        applicationName: 'ff-worker-listener',
        connectTimeoutMs: config.get('DB_CONNECT_TIMEOUT_MS', { infer: true }),
        queryTimeoutMs: config.get('DB_STATEMENT_TIMEOUT_MS', { infer: true }),
      }),
      WorkSignals.name,
    );
  }

  onApplicationShutdown(): Promise<void> {
    return this.stop();
  }
}
