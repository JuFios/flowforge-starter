import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvironmentVariables } from '../config/env.validation';
import { PgListener } from '../common/pg-listener';

/** LISTEN лише пробуджує читачів. Після кожного успішного LISTEN вони перечитують БД. */
@Injectable()
export class ExecutionFeed extends PgListener implements OnApplicationShutdown {
  constructor(config: ConfigService<EnvironmentVariables, true>) {
    super(
      () => ({
        connectionString: config.get('DATABASE_URL', { infer: true }),
        channels: ['ff_execution', 'ff_session_revoked'],
        applicationName: 'ff-realtime-listener',
        connectTimeoutMs: config.get('DB_CONNECT_TIMEOUT_MS', { infer: true }),
        queryTimeoutMs: config.get('DB_STATEMENT_TIMEOUT_MS', { infer: true }),
      }),
      ExecutionFeed.name,
    );
  }

  onApplicationShutdown(): Promise<void> {
    return this.stop();
  }
}
