import 'reflect-metadata';
import { plainToInstance, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
  registerDecorator,
  ValidationArguments,
  validateSync,
} from 'class-validator';

export const LOG_LEVELS = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Найбільша затримка, яку приймають setTimeout/setInterval (2^31 - 1 мс). */
export const MAX_TIMER_MS = 2_147_483_647;

/** Значення-приклади й очевидні заглушки: публічно відомі, тож не є секретом. */
const PLACEHOLDER_SECRET =
  /change[\s_-]*me|example|placeholder|default|password|secret|qwerty|12345/i;
/** Менше різних символів — «aaaa…», «1212…» тощо. */
const MIN_DISTINCT_CHARS = 8;

export function isObviouslyInsecureSecret(value: string): boolean {
  return (
    PLACEHOLDER_SECRET.test(value) || new Set(value).size < MIN_DISTINCT_CHARS
  );
}

/**
 * У production секрет не може бути прикладом із .env.example чи очевидною заглушкою.
 * У development/test приклад дозволений, щоб локальний запуск працював «з коробки».
 */
function IsSecureSecretInProduction(): PropertyDecorator {
  return (target, propertyName) =>
    registerDecorator({
      name: 'isSecureSecretInProduction',
      target: target.constructor,
      propertyName: propertyName as string,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const env = (args.object as { NODE_ENV?: string }).NODE_ENV;
          return (
            env !== 'production' ||
            (typeof value === 'string' && !isObviouslyInsecureSecret(value))
          );
        },
        defaultMessage: () =>
          'у NODE_ENV=production значення з прикладу або очевидна заглушка заборонені; ' +
          'згенеруйте випадкове, напр. `openssl rand -hex 24`',
      },
    });
}

/**
 * Підключення до Postgres. Окремий клас, бо його валідує й CLI міграцій, якому решта
 * конфігурації застосунку (ADMIN_TOKEN тощо) не потрібна.
 */
export class DatabaseEnvironment {
  @IsString()
  @Matches(/^postgres(ql)?:\/\/\S+$/, {
    message: 'DATABASE_URL має бути URL виду postgres://user:pass@host:5432/db',
  })
  DATABASE_URL: string;

  /** Скільки чекати встановлення з'єднання з Postgres (TCP + автентифікація). */
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(60_000)
  DB_CONNECT_TIMEOUT_MS = 5_000;

  /**
   * Межа часу одного SQL-запиту (statement_timeout сесії) і простою відкритої транзакції
   * (idle_in_transaction_session_timeout). CLI міграцій statement_timeout не застосовує.
   */
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(600_000)
  DB_STATEMENT_TIMEOUT_MS = 30_000;
}

/**
 * Схема змінних оточення. Процес не стартує, якщо конфігурація невалідна:
 * краще впасти одразу з зрозумілим повідомленням, ніж працювати з undefined.
 */
export class EnvironmentVariables extends DatabaseEnvironment {
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
  @MinLength(12)
  @IsSecureSecretInProduction()
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
   * Тривалість lease задачі. Воркер продовжує lease (heartbeat) кожну третину цього часу; задачу
   * воркера, що не продовжив lease вчасно (упав, завис, втратив мережу), повертає в чергу reaper.
   * Найдовший крок не обмежений lease-ом: поки воркер живий, lease продовжується.
   */
  @Type(() => Number)
  @IsInt()
  @Min(500)
  @Max(600_000)
  JOB_LEASE_MS = 30_000;

  /**
   * Як часто вільний цикл воркера перевіряє чергу, коли задач немає (з випадковим відхиленням
   * ±50%, щоб воркери не опитували БД синхронно).
   */
  @Type(() => Number)
  @IsInt()
  @Min(10)
  @Max(60_000)
  WORKER_POLL_INTERVAL_MS = 500;

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

export function validateEnv(
  raw: Record<string, unknown>,
): EnvironmentVariables {
  return validateAs(EnvironmentVariables, raw);
}

/** Лише змінні підключення до БД — для CLI міграцій. */
export function validateDatabaseEnv(
  raw: Record<string, unknown>,
): DatabaseEnvironment {
  return validateAs(DatabaseEnvironment, raw);
}

function validateAs<T extends object>(
  schema: new () => T,
  raw: Record<string, unknown>,
): T {
  const env = plainToInstance(schema, raw, { exposeDefaultValues: true });
  const errors = validateSync(env, { skipMissingProperties: false });
  if (errors.length > 0) {
    // Значення не друкуємо: у них можуть бути секрети (пароль у DATABASE_URL, ADMIN_TOKEN).
    const details = errors.map(
      (e) => `${e.property}: ${Object.values(e.constraints ?? {}).join('; ')}`,
    );
    throw new Error(
      `Невалідна конфігурація оточення:\n  ${details.join('\n  ')}`,
    );
  }
  return env;
}
