import { Injectable, Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SessionsController } from './sessions/sessions.controller';
import { SessionsService } from './sessions/sessions.service';
import {
  ApiKeyGuard,
  BrowserSessionGuard,
  TenantAuthGuard,
} from './auth/api-key.guard';
import {
  EnvironmentVariables,
  validateApiEnv,
  validateEnv,
} from './config/env.validation';
import { buildDataSourceOptions, ENTITIES } from './database/database.options';
import {
  RUNTIME_DATABASE_URL,
  RuntimeDatabaseUrlModule,
} from './database/runtime-database-url';
import { CheckpointService } from './engine/checkpoint.service';
import { JobQueueService } from './engine/job-queue.service';
import { JobRunnerService } from './engine/job-runner.service';
import { QueueDepthMetrics } from './engine/queue-depth.metrics';
import { QueueMetrics } from './engine/queue.metrics';
import { StepExecutor } from './engine/step-executor';
import { ExecutionsController } from './executions/executions.controller';
import { ExecutionGateway } from './realtime/execution-gateway.service';
import { ExecutionFeed } from './realtime/execution-feed.service';
import { ExecutionWatches } from './realtime/execution-watches.service';
import { WorkSignals } from './engine/work-signals.service';
import { ExecutionReader } from './executions/execution-reader.service';
import { ExecutionsService } from './executions/executions.service';
import { LimitsModule } from './limits/limits.module';
import { MetricsController } from './observability/metrics.controller';
import { NotificationsController } from './notifications/notifications.controller';
import { NotificationsService } from './notifications/notifications.service';
import { OutboxMetrics } from './outbox/outbox.metrics';
import { OutboxSender } from './outbox/outbox-sender.service';
import { MetricsServer } from './observability/metrics-server';
import { ObservabilityModule } from './observability/observability.module';
import { SchedulerMetrics } from './scheduler/scheduler.metrics';
import { SchedulerService } from './scheduler/scheduler.service';
import { TenancyModule } from './tenancy/tenancy.module';
import { TenantsController } from './tenants/tenants.controller';
import { WebhookKeysController } from './webhooks/webhook-keys.controller';
import { WebhookKeysService } from './webhooks/webhook-keys.service';
import { WebhooksController } from './webhooks/webhooks.controller';
import { WorkflowsController } from './workflows/workflows.controller';
import { WorkflowsService } from './workflows/workflows.service';

/** Спільна основа обох процесів: валідована конфігурація, БД, спостережуваність. */
const coreImports = [
  ConfigModule.forRoot({
    isGlobal: true,
    cache: true,
    validate: validateEnv,
    // У тестах оточення задається явно, локальний .env розробника не повинен впливати.
    ignoreEnvFile: process.env.NODE_ENV === 'test',
  }),
  TypeOrmModule.forRootAsync({
    imports: [RuntimeDatabaseUrlModule],
    inject: [ConfigService, RUNTIME_DATABASE_URL],
    useFactory: (
      config: ConfigService<EnvironmentVariables, true>,
      databaseUrl: string,
    ) =>
      buildDataSourceOptions(
        {
          DATABASE_URL: databaseUrl,
          DB_CONNECT_TIMEOUT_MS: config.get('DB_CONNECT_TIMEOUT_MS', {
            infer: true,
          }),
          DB_STATEMENT_TIMEOUT_MS: config.get('DB_STATEMENT_TIMEOUT_MS', {
            infer: true,
          }),
        },
        { poolSize: config.get('DB_POOL_SIZE', { infer: true }) },
      ),
  }),
  TypeOrmModule.forFeature(ENTITIES),
  ObservabilityModule,
];

/**
 * Конфігурацію API перевіряє ще й власна схема (ApiEnvironment: обов'язковий ADMIN_TOKEN). Спільна
 * схема ConfigModule його не вимагає — воркер цього секрету не отримує.
 */
@Injectable()
class ApiEnvironmentCheck implements OnModuleInit {
  onModuleInit(): void {
    validateApiEnv(process.env);
  }
}

/** HTTP API + планувальник. Метрики — на окремому службовому порту (MetricsServer, METRICS_PORT). */
@Module({
  imports: [...coreImports, TenancyModule.forRoot('api'), LimitsModule],
  controllers: [
    SessionsController,
    TenantsController,
    WorkflowsController,
    ExecutionsController,
    WebhooksController,
    WebhookKeysController,
    NotificationsController,
  ],
  providers: [
    ApiEnvironmentCheck,
    ApiKeyGuard,
    BrowserSessionGuard,
    TenantAuthGuard,
    SessionsService,
    WorkflowsService,
    ExecutionsService,
    ExecutionReader,
    ExecutionGateway,
    ExecutionFeed,
    ExecutionWatches,
    WebhookKeysService,
    NotificationsService,
    SchedulerService,
    SchedulerMetrics,
    MetricsServer,
  ],
})
export class AppModule {}

/** Окремий процес-воркер. HTTP лише службовий: /health, /ready, /metrics. */
@Module({
  imports: [
    ...coreImports,
    TenancyModule.forRoot('worker'),
    RuntimeDatabaseUrlModule,
  ],
  controllers: [MetricsController],
  providers: [
    JobQueueService,
    CheckpointService,
    JobRunnerService,
    StepExecutor,
    QueueMetrics,
    QueueDepthMetrics,
    OutboxSender,
    OutboxMetrics,
    WorkSignals,
  ],
})
export class WorkerModule {}
