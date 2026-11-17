import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { TerminusModule } from '@nestjs/terminus';
import { LoggerModule } from 'nestjs-pino';
import { EnvironmentVariables } from '../config/env.validation';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { CorrelationIdMiddleware } from './correlation.middleware';
import { HealthController } from './health.controller';
import { buildLoggerParams } from './logger.options';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

/** Спільна для API і воркера спостережуваність: логи, кореляція, метрики, health/readiness, помилки. */
@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) =>
        buildLoggerParams(config.get('LOG_LEVEL', { infer: true })),
    }),
    TerminusModule,
  ],
  controllers: [HealthController, MetricsController],
  providers: [MetricsService, { provide: APP_FILTER, useClass: AllExceptionsFilter }],
  exports: [MetricsService],
})
export class ObservabilityModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
