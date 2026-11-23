import 'reflect-metadata';
import {
  DEFAULT_HTTP_TIMEOUT_MS,
  MAX_HTTP_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  outboundSettings,
} from './outbound';
import { MAX_DETAIL_BYTES } from '../executions/detail-limits';
import { isIP } from 'node:net';
import { plainToInstance, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
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
/** Найдовший тік планувальника: запізнення вчасного спрацювання не більше хвилини (3.3.8). */
export const MAX_SCHEDULER_TICK_MS = 60_000;

/** Межі HTTP_BODY_LIMIT, байт: 68 КіБ (визначення 64 КіБ + решта полів) .. 1 МіБ. */
export const MIN_HTTP_BODY_LIMIT = 68 * 1024;
export const MAX_HTTP_BODY_LIMIT = 1024 * 1024;

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

/** Пароль з URL підключення (`postgres://user:pass@…`), якщо він є. */
function urlPassword(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  try {
    return decodeURIComponent(new URL(url).password) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Секрети-заглушки з `.env.example` дозволені лише поза production: локальний compose
 * запускається одразу після `cp .env.example .env`, а його порти слухають тільки 127.0.0.1.
 * У NODE_ENV=production заглушка в паролі БД зупиняє процес; поза production — попередження
 * на старті (без значень).
 */
export function checkPlaceholderSecrets(
  raw: Record<string, unknown>,
  secrets: Record<string, string | undefined>,
): void {
  const insecure = Object.entries(secrets)
    .filter(
      ([, value]) => value !== undefined && isObviouslyInsecureSecret(value),
    )
    .map(([name]) => name);
  if (insecure.length === 0) return;
  if (raw.NODE_ENV === 'production')
    throw new Error(
      `Невалідна конфігурація оточення:\n  ${insecure.join(', ')}: у NODE_ENV=production ` +
        'значення з прикладу або очевидна заглушка заборонені; згенеруйте випадкове, напр. `openssl rand -hex 24`',
    );
  if (raw.NODE_ENV !== 'test')
    process.stderr.write(
      JSON.stringify({
        level: 40,
        msg: 'placeholder secrets in use: allowed only outside NODE_ENV=production',
        secrets: insecure,
      }) + '\n',
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

/** Значення не менше за значення іншої властивості того самого об'єкта (плюс `extra`). */
function IsNotLessThan(other: string, extra = 0): PropertyDecorator {
  return (target, propertyName) =>
    registerDecorator({
      name: 'isNotLessThan',
      target: target.constructor,
      propertyName: propertyName as string,
      constraints: [other, extra],
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const bound = (args.object as Record<string, unknown>)[other];
          return (
            typeof value !== 'number' ||
            typeof bound !== 'number' ||
            value >= bound + extra
          );
        },
        defaultMessage: () =>
          `має бути не менше за ${other}${extra ? ` + ${extra}` : ''}`,
      },
    });
}

/**
 * Значення не менше за `factor` × значення іншої властивості. Правило спільних пулів інстансу API
 * (docs/operations.md, «Спільні пули API»): частка одного тенанта — не більше половини пулу.
 */
function IsAtLeastTimes(other: string, factor: number): PropertyDecorator {
  return (target, propertyName) =>
    registerDecorator({
      name: 'isAtLeastTimes',
      target: target.constructor,
      propertyName: propertyName as string,
      constraints: [other, factor],
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const bound = (args.object as Record<string, unknown>)[other];
          return (
            typeof value !== 'number' ||
            typeof bound !== 'number' ||
            value >= bound * factor
          );
        },
        defaultMessage: () => `має бути не менше за ${factor} × ${other}`,
      },
    });
}

/** Іменовані підмережі, які розуміє Express `trust proxy`. */
const TRUST_PROXY_NAMES = new Set(['loopback', 'linklocal', 'uniquelocal']);

/**
 * Значення TRUST_PROXY для Express `trust proxy`: false, кількість переходів або перелік адрес і
 * підмереж проксі. `true` (довіряти будь-кому) не приймається: тоді клієнт сам задавав би свою IP
 * через X-Forwarded-For і обходив би ліміти за IP. Невалідне значення — undefined.
 */
export function parseTrustProxy(
  value: string,
): false | number | string[] | undefined {
  const trimmed = value.trim();
  if (trimmed === 'false' || trimmed === '') return false;
  if (/^\d+$/.test(trimmed)) {
    const hops = Number(trimmed);
    return hops >= 1 && hops <= 10 ? hops : undefined;
  }
  const entries = trimmed.split(',').map((e) => e.trim());
  const valid = entries.every((entry) => {
    if (TRUST_PROXY_NAMES.has(entry)) return true;
    const [address, prefix, ...rest] = entry.split('/');
    const family = isIP(address);
    if (family === 0 || rest.length > 0) return false;
    if (prefix === undefined) return true;
    if (!/^\d{1,3}$/.test(prefix)) return false;
    return Number(prefix) > 0 && Number(prefix) <= (family === 4 ? 32 : 128);
  });
  return valid ? entries : undefined;
}

function IsTrustProxy(): PropertyDecorator {
  return (target, propertyName) =>
    registerDecorator({
      name: 'isTrustProxy',
      target: target.constructor,
      propertyName: propertyName as string,
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' && parseTrustProxy(value) !== undefined,
        defaultMessage: () =>
          'має бути false, кількість проксі-переходів 1..10 або перелік IP/підмереж проксі через кому',
      },
    });
}

/**
 * Запас пулу понад WORKER_CONCURRENCY: heartbeat-и задач у роботі (паралельно з записами
 * циклів), reaper, очищення старих задач і перевірка /ready.
 */
export const DB_POOL_HEADROOM = 4;

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

  @Type(() => Number)
  @IsInt()
  @Min(1000)
  @Max(86_400_000)
  SESSION_TTL_MS = 28_800_000;
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  SESSION_MAX_PER_TENANT = 100;
  @Type(() => Number)
  @IsInt()
  @Min(1000)
  @Max(60_000)
  REALTIME_TICKET_TTL_MS = 30_000;
  @Type(() => Number)
  @IsInt()
  @Min(2)
  @Max(10000)
  @IsAtLeastTimes('REALTIME_MAX_CONNECTIONS_PER_TENANT', 2)
  REALTIME_MAX_CONNECTIONS = 256;
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  REALTIME_MAX_CONNECTIONS_PER_TENANT = 32;

  /**
   * Спільний пул знімків `GET /executions/:id` інстансу API: одночасні знімки, частка тенанта й
   * диск тимчасових файлів. Частка одного тенанта — не більше половини кожного ресурсу.
   */
  @Type(() => Number)
  @IsInt()
  @Min(2)
  @Max(256)
  @IsAtLeastTimes('DETAIL_MAX_PER_TENANT', 2)
  DETAIL_MAX_CONCURRENT = 8;
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(16)
  DETAIL_MAX_PER_TENANT = 1;
  @Type(() => Number)
  @IsInt()
  @Min(2 * MAX_DETAIL_BYTES)
  @Max(Number.MAX_SAFE_INTEGER)
  @IsAtLeastTimes('DETAIL_MAX_PER_TENANT', 2 * MAX_DETAIL_BYTES)
  DETAIL_DISK_BUDGET_BYTES = 1024 * 1024 * 1024;

  /**
   * Службовий порт API лише для GET /metrics. Не публікується назовні (docker-compose),
   * на публічному PORT метрик немає. 0 — випадковий вільний порт (інтеграційні тести).
   */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(65535)
  METRICS_PORT = 3200;

  /**
   * Найбільше JSON-тіло HTTP-запиту, байт; більше — 413 ще до розбору. Нижня межа гарантує, що
   * найбільші легітимні тіла вміщуються: визначення кроків до 64 КіБ плюс решта полів workflow
   * (вхід виконання — теж до 64 КіБ). Верхня обмежує пам'ять, яку займає один запит.
   */
  @Type(() => Number)
  @IsInt()
  @Min(MIN_HTTP_BODY_LIMIT)
  @Max(MAX_HTTP_BODY_LIMIT)
  HTTP_BODY_LIMIT = 100 * 1024;

  @IsString()
  HTTP_DENY_CIDRS = '';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_HTTP_TIMEOUT_MS)
  HTTP_STEP_TIMEOUT_MS = DEFAULT_HTTP_TIMEOUT_MS;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_RESPONSE_BYTES)
  HTTP_RESPONSE_BYTES = MAX_RESPONSE_BYTES;

  /**
   * Токен службових ендпоінтів `/tenants…`. Потрібен лише API (ApiEnvironment): воркер його не
   * отримує, щоб компрометація воркера не давала адмін-доступу. Якщо заданий — перевіряється.
   */
  @IsOptional()
  @IsString()
  @MinLength(12)
  @IsSecureSecretInProduction()
  ADMIN_TOKEN?: string;

  /**
   * Скільки запитів до `/tenants…` приймається з однієї IP-адреси за вікно ADMIN_RATE_WINDOW_MS
   * (захист адмін-токена від перебору; лічильник у Postgres, спільний для інстансів API).
   */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  ADMIN_RATE_LIMIT = 30;

  @Type(() => Number)
  @IsInt()
  @Min(1_000)
  @Max(3_600_000)
  ADMIN_RATE_WINDOW_MS = 60_000;

  /**
   * Скільки невдалих автентифікацій (невірний API-ключ, невірний підпис webhook-а) з однієї
   * IP-адреси за вікно AUTH_FAILURE_RATE_WINDOW_MS; понад це — 429 замість 401. Успішні запити не
   * рахуються.
   */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  AUTH_FAILURE_RATE_LIMIT = 30;

  @Type(() => Number)
  @IsInt()
  @Min(1_000)
  @Max(3_600_000)
  AUTH_FAILURE_RATE_WINDOW_MS = 60_000;

  /**
   * Довіра до X-Forwarded-For (Express `trust proxy`) для IP клієнта в лімітах за IP: `false` (за
   * замовчуванням — API без проксі попереду), кількість проксі-переходів (1..10) або перелік
   * адрес/підмереж проксі через кому. Довіра без проксі дала б клієнту підробляти свою IP-адресу.
   */
  @IsTrustProxy()
  TRUST_PROXY = 'false';

  @IsIn(LOG_LEVELS)
  LOG_LEVEL: LogLevel = 'info';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(64)
  WORKER_CONCURRENCY = 4;

  /**
   * Найбільша кількість з'єднань із Postgres в одному процесі (пул pg). Не менша за
   * WORKER_CONCURRENCY + запас: інакше при повільній БД heartbeat-и стоять у черзі пулу позаду
   * опитувань черги, і lease-и минають. Сума пулів усіх процесів має вміщатися в max_connections.
   */
  @Type(() => Number)
  @IsInt()
  @Min(1 + DB_POOL_HEADROOM)
  @Max(1000)
  @IsNotLessThan('WORKER_CONCURRENCY', DB_POOL_HEADROOM)
  DB_POOL_SIZE = 10;

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
   * Скільки спроб має кожен крок виконання (лічильник починається знову після кожного
   * завершеного кроку). Після вичерпання повторюваних помилок задача переходить у стан `dead`.
   */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  JOB_MAX_ATTEMPTS = 5;

  /** Нижня межа затримки повтору задачі, мс (і база експоненти). */
  @Type(() => Number)
  @IsInt()
  @Min(10)
  @Max(3_600_000)
  JOB_BACKOFF_BASE_MS = 1_000;

  /** Верхня межа затримки повтору задачі, мс. Не менша за JOB_BACKOFF_BASE_MS. */
  @Type(() => Number)
  @IsInt()
  @Min(10)
  @Max(86_400_000)
  @IsNotLessThan('JOB_BACKOFF_BASE_MS')
  JOB_BACKOFF_MAX_MS = 300_000;

  /**
   * Скільки воркер під час завершення чекає на задачі в роботі; потім скасовує їх і повертає в
   * чергу. Має бути помітно меншим за час, який оркестратор дає на зупинку (у compose —
   * stop_grace_period воркера), інакше процес буде вбито раніше, ніж задачі повернуться.
   */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(600_000)
  WORKER_SHUTDOWN_GRACE_MS = 20_000;

  /**
   * Скільки днів зберігаються завершені задачі (`done`, `failed`, `dead`), перш ніж воркер їх
   * видалить. Виконання й кроки не видаляються — це історія тенанта, яку показує API.
   */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  JOB_RETENTION_DAYS = 30;

  /**
   * Скільки днів зберігається історія виконань (`executions` разом із `step_runs` і `jobs`) після
   * завершення. 0 — зберігати завжди (за замовчуванням): історію тенанта, яку показує API,
   * платформа без явного рішення оператора не видаляє.
   */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(3650)
  EXECUTION_RETENTION_DAYS = 0;

  /** Як часто кожен воркер видаляє завершені задачі, старші за JOB_RETENTION_DAYS (з jitter). */
  @Type(() => Number)
  @IsInt()
  @Min(1_000)
  @Max(MAX_TIMER_MS)
  JOB_CLEANUP_INTERVAL_MS = 3_600_000;

  /**
   * Інтервал тіку планувальника: без перешкод вчасний момент обробляється на найближчому тіку;
   * зайнятий рядок, повна черга чи квота outbox і простій відкладають спрацювання (README 3.3.8). Тік
   * обробляє лише належні розклади (індекс за `nextFireAt`), тож короткий інтервал не множить
   * роботу на кількість розкладів. Верхня межа — хвилина, найдрібніший крок 5-польного cron:
   * довший тік виконував би щохвилинні розклади пачками.
   */
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(MAX_SCHEDULER_TICK_MS)
  SCHEDULER_TICK_MS = 30_000;

  /**
   * Момент розкладу, старший за стільки мс на час обробки, вважається пропущеним (простій, БД
   * недоступна, повна черга) і обробляється за політикою workflow (`missedRunPolicy`). Не менше
   * за SCHEDULER_TICK_MS: інакше звичайне запізнення тіку рахувалося б пропуском.
   */
  @Type(() => Number)
  @IsInt()
  @Min(1_000)
  @Max(MAX_TIMER_MS)
  SCHEDULER_MISFIRE_GRACE_MS = 60_000;

  /** Циклів доставки сповіщень на воркер (README 3.3.9); 0 — воркер сповіщень не надсилає. */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(64)
  OUTBOX_CONCURRENCY = 4;

  /** Скільки спроб доставки одного тенанта можуть іти одночасно в усьому кластері. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(64)
  OUTBOX_TENANT_IN_FLIGHT = 2;

  /** Пауза опитування, коли надсилати нічого, мс (з відхиленням ±50%). */
  @Type(() => Number)
  @IsInt()
  @Min(10)
  @Max(60_000)
  OUTBOX_POLL_INTERVAL_MS = 1_000;

  /** Таймаут однієї спроби доставки, мс; не більше за HTTP_STEP_TIMEOUT_MS. */
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(60_000)
  OUTBOX_HTTP_TIMEOUT_MS = 10_000;

  /** Нижня межа backoff між спробами доставки, мс. */
  @Type(() => Number)
  @IsInt()
  @Min(10)
  @Max(MAX_TIMER_MS)
  OUTBOX_BACKOFF_BASE_MS = 5_000;

  /**
   * Стеля backoff, мс. Спроб без ліміту: недоставлена подія не видаляється й повторюється не рідше
   * за цю стелю, доки отримувач не відповість 2xx (гарантія «щонайменше один раз»).
   */
  @Type(() => Number)
  @IsInt()
  @Min(10)
  @Max(MAX_TIMER_MS)
  OUTBOX_BACKOFF_MAX_MS = 3_600_000;

  /** Скільки днів зберігати доставлені події (недоставлені не видаляються), 1..3650. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  OUTBOX_RETENTION_DAYS = 7;
}

/** Конфігурація процесу API: спільна плюс обов'язковий ADMIN_TOKEN. */
export type ApiEnvironment = EnvironmentVariables & { ADMIN_TOKEN: string };

/**
 * Облікові дані власника схеми (міграції) runtime-процесам заборонені: API і воркер ходять у БД
 * лише своїми ролями без BYPASSRLS, а URL власника є тільки в кроці міграцій.
 */
const OWNER_CREDENTIALS = ['MIGRATION_DATABASE_URL'] as const;

function rejectOwnerCredentials(raw: Record<string, unknown>): void {
  const present = OWNER_CREDENTIALS.filter(
    (name) => typeof raw[name] === 'string' && raw[name] !== '',
  );
  if (present.length > 0)
    throw new Error(
      `Невалідна конфігурація оточення:\n  ${present.join(', ')}: облікові дані власника БД не передаються API і воркеру (лише кроку міграцій)`,
    );
}

/** Спільна схема API і воркера (ConfigModule). */
export function validateEnv(
  raw: Record<string, unknown>,
): EnvironmentVariables {
  rejectOwnerCredentials(raw);
  outboundSettings(raw);
  const env = checkRelations(validateAs(EnvironmentVariables, raw));
  checkPlaceholderSecrets(raw, {
    DATABASE_URL: urlPassword(raw.DATABASE_URL),
    ADMIN_TOKEN: env.ADMIN_TOKEN,
  });
  return env;
}

/** Узгодженість пов'язаних параметрів: межа пропуску, таймаут і backoff сповіщень. */
function checkRelations<T extends EnvironmentVariables>(env: T): T {
  const problems: string[] = [];
  if (env.SCHEDULER_MISFIRE_GRACE_MS < env.SCHEDULER_TICK_MS)
    problems.push(
      'SCHEDULER_MISFIRE_GRACE_MS: не може бути меншим за SCHEDULER_TICK_MS',
    );
  if (env.OUTBOX_BACKOFF_MAX_MS < env.OUTBOX_BACKOFF_BASE_MS)
    problems.push(
      'OUTBOX_BACKOFF_MAX_MS: не може бути меншим за OUTBOX_BACKOFF_BASE_MS',
    );
  if (problems.length)
    throw new Error(
      `Невалідна конфігурація оточення:\n  ${problems.join('\n  ')}`,
    );
  return env;
}

/** Схема API: спільна плюс обов'язковий ADMIN_TOKEN. */
export function validateApiEnv(raw: Record<string, unknown>): ApiEnvironment {
  rejectOwnerCredentials(raw);
  outboundSettings(raw);
  const env = checkRelations(validateAs(EnvironmentVariables, raw));
  // Явна перевірка: @IsOptional спільної схеми вимикає для цієї властивості будь-які інші
  // декоратори, зокрема @IsDefined.
  if (env.ADMIN_TOKEN === undefined)
    throw new Error(
      "Невалідна конфігурація оточення:\n  ADMIN_TOKEN: обов'язковий для API",
    );
  return env as ApiEnvironment;
}

/** Лише змінні підключення до БД — для CLI міграцій. */
export function validateDatabaseEnv(
  raw: Record<string, unknown>,
): DatabaseEnvironment {
  const env = validateAs(DatabaseEnvironment, raw);
  checkPlaceholderSecrets(raw, { DATABASE_URL: urlPassword(raw.DATABASE_URL) });
  return env;
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
