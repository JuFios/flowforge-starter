import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { EnvironmentVariables } from '../config/env.validation';
import { ObservabilityModule } from '../observability/observability.module';
import { SystemDb } from '../tenancy/system-db';
import { AuthFailureLimiter } from './auth-failure.limiter';
import { LimitsMetrics } from './limits.metrics';
import { PostgresThrottlerStorage } from './postgres-throttler.storage';
import { RateLimitGuard, throttlerOptions } from './rate-limit.guard';
import { RateLimitPurger } from './rate-limit.purger';

/** Ліміти частоти запитів API (`@nestjs/throttler`, сховище — Postgres) і їхні метрики. */
@Module({
  imports: [
    ObservabilityModule,
    ThrottlerModule.forRootAsync({
      inject: [ConfigService, SystemDb],
      useFactory: (
        config: ConfigService<EnvironmentVariables, true>,
        system: SystemDb,
      ) => ({
        ...throttlerOptions(config),
        storage: new PostgresThrottlerStorage(system),
      }),
    }),
  ],
  providers: [
    LimitsMetrics,
    AuthFailureLimiter,
    RateLimitGuard,
    RateLimitPurger,
  ],
  exports: [ThrottlerModule, LimitsMetrics, AuthFailureLimiter, RateLimitGuard],
})
export class LimitsModule {}
