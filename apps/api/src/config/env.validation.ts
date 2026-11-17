import 'reflect-metadata';
import { plainToInstance, Type } from 'class-transformer';
import { IsIn, IsInt, IsString, Matches, Max, Min, MinLength, validateSync } from 'class-validator';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Найбільша затримка, яку приймають setTimeout/setInterval (2^31 - 1 мс). */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * Схема змінних оточення. Процес не стартує, якщо конфігурація невалідна:
 * краще впасти одразу з зрозумілим повідомленням, ніж працювати з undefined.
 */
export class EnvironmentVariables {
  @IsIn(['development', 'test', 'production'])
  NODE_ENV: 'development' | 'test' | 'production' = 'development';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT = 3000;

  /**
   * Службовий порт API лише для GET /metrics. Не публікується назовні (docker-compose),
   * на публічному PORT метрик немає. 0 — випадковий вільний порт (інтеграційні тести).
   */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(65535)
  METRICS_PORT = 3200;

  @IsString()
  @Matches(/^postgres(ql)?:\/\/\S+$/, { message: 'DATABASE_URL має бути URL виду postgres://user:pass@host:5432/db' })
  DATABASE_URL: string;

  @IsString()
  @MinLength(12)
  ADMIN_TOKEN: string;

  @IsIn(LOG_LEVELS)
  LOG_LEVEL: LogLevel = 'info';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(64)
  WORKER_CONCURRENCY = 4;

  /** Порт службового HTTP воркера (/health, /ready, /metrics). */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  WORKER_HTTP_PORT = 3100;

  /**
   * ТИМЧАСОВА МЕЖА — до переробки планувальника (ТЗ 3.3.8).
   * Лише захищає setInterval від переповнення: більше за MAX_TIMER_MS Node мовчки
   * перетворює на 1 мс. Допустиме запізнення cron вона не обмежує; змістовну межу
   * (або відмову від фіксованого тіку) визначає переробка планувальника.
   */
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(MAX_TIMER_MS)
  SCHEDULER_TICK_MS = 30_000;
}

export function validateEnv(raw: Record<string, unknown>): EnvironmentVariables {
  const env = plainToInstance(EnvironmentVariables, raw, { exposeDefaultValues: true });
  const errors = validateSync(env, { skipMissingProperties: false });
  if (errors.length > 0) {
    // Значення не друкуємо: у них можуть бути секрети (пароль у DATABASE_URL, ADMIN_TOKEN).
    const details = errors.map((e) => `${e.property}: ${Object.values(e.constraints ?? {}).join('; ')}`);
    throw new Error(`Невалідна конфігурація оточення:\n  ${details.join('\n  ')}`);
  }
  return env;
}
