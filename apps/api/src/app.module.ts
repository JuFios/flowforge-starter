import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiKeyGuard } from './auth/api-key.guard';
import { EnvironmentVariables, validateEnv } from './config/env.validation';
import { buildDataSourceOptions, ENTITIES } from './database/database.options';
import { JobQueueService } from './engine/job-queue.service';
import { JobRunnerService } from './engine/job-runner.service';
import { StepExecutor } from './engine/step-executor';
import { ExecutionsController } from './executions/executions.controller';
import { ExecutionsService } from './executions/executions.service';
import { ObservabilityModule } from './observability/observability.module';
import { SchedulerService } from './scheduler/scheduler.service';
import { TenantsController } from './tenants/tenants.controller';
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
    inject: [ConfigService],
    useFactory: (config: ConfigService<EnvironmentVariables, true>) =>
      buildDataSourceOptions(config.get('DATABASE_URL', { infer: true })),
  }),
  TypeOrmModule.forFeature(ENTITIES),
  ObservabilityModule,
];

/** HTTP API + планувальник. */
@Module({
  imports: coreImports,
  controllers: [TenantsController, WorkflowsController, ExecutionsController, WebhooksController],
  providers: [ApiKeyGuard, WorkflowsService, ExecutionsService, SchedulerService],
})
export class AppModule {}

/** Окремий процес-воркер. HTTP лише службовий: /health, /ready, /metrics. */
@Module({
  imports: coreImports,
  providers: [JobQueueService, JobRunnerService, StepExecutor],
})
export class WorkerModule {}
