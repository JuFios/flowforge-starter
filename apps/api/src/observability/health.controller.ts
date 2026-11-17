import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckError, HealthCheckService, HealthIndicatorResult, TypeOrmHealthIndicator } from '@nestjs/terminus';

@Controller()
export class HealthController {
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
    } catch {
      // Текст помилки драйвера (адреса хоста, причина) назовні не віддаємо.
      throw new HealthCheckError('database unavailable', { database: { status: 'down' } });
    }
  }
}
