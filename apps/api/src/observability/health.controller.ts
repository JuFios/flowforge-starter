import { Controller, Get, Logger } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckError,
  HealthCheckService,
  HealthIndicatorResult,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';
import { toSafeError } from './safe-error';

@Controller()
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
  ) {}

  /** Liveness: процес живий і обробляє HTTP. Залежності не перевіряє. */
  @Get('health')
  @HealthCheck()
  liveness() {
    return this.health.check([]);
  }

  /** Readiness: процес може виконувати роботу (БД доступна). */
  @Get('ready')
  @HealthCheck()
  readiness() {
    return this.health.check([() => this.database()]);
  }

  private async database(): Promise<HealthIndicatorResult> {
    try {
      return await this.db.pingCheck('database', { timeout: 2000 });
    } catch (err) {
      // Текст помилки драйвера (адреса хоста, причина) назовні не віддаємо — лише в лог.
      this.logger.warn(
        { error: toSafeError(err) },
        'readiness: database check failed',
      );
      throw new HealthCheckError('database unavailable', {
        database: { status: 'down' },
      });
    }
  }
}
