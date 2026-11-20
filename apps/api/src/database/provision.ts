import 'reflect-metadata';
import { lockClusterRoles } from './cluster-role-lock';
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { BUILT_IN_LIMIT_DEFAULTS, LIMIT_BOUNDS } from '../tenancy/limits';
import { API_ROLE, SYSTEM_ROLE, WORKER_ROLE } from '../tenancy/roles';
import {
  assertNoForeignMembers,
  UNSAFE_GROUP_SQL,
  UNSAFE_LOGIN_SQL,
} from '../tenancy/login-role-check';
import { loadDotEnvIfPresent } from './cli-env';
import { buildDataSourceOptions } from './database.options';
import { validateDatabaseEnv } from '../config/env.validation';

/** Ітерацій PBKDF2 у SCRAM verifier — як `scram_iterations` Postgres за замовчуванням. */
export const SCRAM_ITERATIONS = 4096;

/** Ім'я login-ролі: звичайний ідентифікатор Postgres без лапок. */
const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
/**
 * Пароль: лише латинські літери й цифри (потрапляє в URL підключення без екранування; SASLprep для
 * такого набору нічого не змінює), щонайменше 24 символи.
 */
const PASSWORD = /^[A-Za-z0-9]{24,256}$/;

export interface LoginRole {
  user: string;
  password: string;
  /** Групова роль процесу: API_ROLE або WORKER_ROLE. */
  group: typeof API_ROLE | typeof WORKER_ROLE;
}

/**
 * SCRAM-SHA-256 verifier пароля (RFC 7677; формат `pg_authid.rolpassword`), обчислений на клієнті —
 * як це робить `psql \password`. На сервер іде лише verifier, тож пароль у відкритому вигляді не
 * потрапляє ні в лог Postgres, ні в `pg_stat_statements`.
 */
export function scramVerifier(
  password: string,
  salt: Buffer = randomBytes(16),
  iterations = SCRAM_ITERATIONS,
): string {
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

export function validateLoginRole(role: LoginRole): void {
  if (!ROLE_NAME.test(role.user))
    throw new Error(
      `invalid database role name for ${role.group}: use lowercase letters, digits and _`,
    );
  if (!PASSWORD.test(role.password))
    throw new Error(
      `invalid password for the database role ${role.user}: 24..256 letters and digits (e.g. openssl rand -hex 24)`,
    );
}

export type Query = (sql: string, params?: unknown[]) => Promise<unknown>;

/**
 * Створює або оновлює login-ролі процесів (ідемпотентно): роль без суперкористувача й BYPASSRLS,
 * член лише своєї групової ролі, з явним правом підключення до цільової БД. Пароль — SCRAM verifier.
 * Відмовляється керувати суперкористувачем, власником схеми чи службовими груповими ролями.
 */
export async function provisionLoginRoles(
  query: Query,
  roles: LoginRole[],
): Promise<void> {
  const users = new Set<string>();
  for (const role of roles) {
    validateLoginRole(role);
    if (users.has(role.user))
      throw new Error(
        'API and worker must use different database roles (least privilege per process)',
      );
    users.add(role.user);
  }
  const [{ superuser, database }] = (await query(
    `SELECT r.rolsuper AS superuser, current_database() AS database
       FROM pg_roles r WHERE r.rolname = current_user`,
  )) as Array<{ superuser: boolean; database: string }>;
  if (!superuser)
    throw new Error('db:provision must run as a PostgreSQL superuser');

  await lockClusterRoles(query);
  const existingUsers = new Set<string>();
  for (const role of roles) {
    const unsafeGroup = (await query(UNSAFE_GROUP_SQL, [
      role.group,
    ])) as unknown[];
    if (unsafeGroup.length)
      throw new Error(
        `refusing to manage ${role.user}: unexpected group privileges`,
      );
    const rows = (await query(
      'SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1',
      [role.user],
    )) as unknown[];
    if (!rows.length) continue;
    existingUsers.add(role.user);
    const unsafe = (await query(UNSAFE_LOGIN_SQL, [
      role.user,
      role.group,
    ])) as unknown[];
    if (
      unsafe.length ||
      [API_ROLE, WORKER_ROLE, SYSTEM_ROLE].some((name) => name === role.user)
    )
      throw new Error(
        `refusing to manage ${role.user}: unexpected privileges, ownership or membership`,
      );
    // Свій логін — лише той, що вже входить у свою групу: CREATE ROLE і GRANT виконуються в одній
    // транзакції, тож роль від db:provision без членства не буває. Чужому логіну з тим самим ім'ям
    // пароль не змінюємо і прав застосунку не даємо.
    const provisioned = (await query(
      `SELECT 1 FROM pg_catalog.pg_auth_members am
         JOIN pg_catalog.pg_roles g ON g.oid = am.roleid
         JOIN pg_catalog.pg_roles m ON m.oid = am.member
        WHERE m.rolname = $1 AND g.rolname = $2`,
      [role.user, role.group],
    )) as unknown[];
    if (!provisioned.length)
      throw new Error(
        `refusing to manage ${role.user}: the role exists but is not a member of ${role.group}, so db:provision did not create it; drop the role or choose another name`,
      );
  }

  // Пароль і членство не видаються, поки службовою роллю може діяти хтось сторонній (перевірка —
  // після власних перевірок логінів, щоб їхні проблеми мали точніше повідомлення).
  await assertNoForeignMembers(query, [
    SYSTEM_ROLE,
    ...new Set(roles.map((role) => role.group)),
  ]);

  for (const role of roles) {
    const attributes = `LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT PASSWORD '${scramVerifier(role.password)}'`;
    await query(
      existingUsers.has(role.user)
        ? `ALTER ROLE "${role.user}" ${attributes}`
        : `CREATE ROLE "${role.user}" ${attributes}`,
    );
    await query(`GRANT ${role.group} TO "${role.user}"`);
  }
  const db = `"${database.replace(/"/g, '""')}"`;
  await query(`REVOKE CONNECT ON DATABASE ${db} FROM PUBLIC`);
  for (const role of roles)
    await query(`GRANT CONNECT ON DATABASE ${db} TO "${role.user}"`);
}

/** Значення лімітів тенантів за замовчуванням (`limit_defaults`; перевизначення — у тенанта). */
export interface LimitDefaults {
  maxRunning: number;
  maxQueueSize: number;
  rateLimit: number;
  rateWindowMs: number;
  webhookRateLimit: number;
  webhookRateWindowMs: number;
}

/** Змінна env кожного значення за замовчуванням і її межі. */
const LIMIT_ENV: Record<
  keyof LimitDefaults,
  [string, readonly [number, number]]
> = {
  maxRunning: ['TENANT_MAX_RUNNING', LIMIT_BOUNDS.maxRunning],
  maxQueueSize: ['TENANT_MAX_QUEUE_SIZE', LIMIT_BOUNDS.maxQueueSize],
  rateLimit: ['TENANT_RATE_LIMIT', LIMIT_BOUNDS.rateLimit],
  rateWindowMs: ['TENANT_RATE_WINDOW_MS', LIMIT_BOUNDS.rateWindowMs],
  webhookRateLimit: ['TENANT_WEBHOOK_RATE_LIMIT', LIMIT_BOUNDS.rateLimit],
  webhookRateWindowMs: [
    'TENANT_WEBHOOK_RATE_WINDOW_MS',
    LIMIT_BOUNDS.rateWindowMs,
  ],
};

/** Значення за замовчуванням з env (`TENANT_*`), а без змінної — вбудовані; поза межами — помилка. */
export function limitDefaultsFromEnv(env: NodeJS.ProcessEnv): LimitDefaults {
  const result = { ...BUILT_IN_LIMIT_DEFAULTS };
  for (const key of Object.keys(LIMIT_ENV) as Array<keyof LimitDefaults>) {
    const [name, [lo, hi]] = LIMIT_ENV[key];
    const raw = env[name];
    if (raw === undefined || raw === '') continue;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || value < lo || value > hi)
      throw new Error(`${name} must be an integer ${lo}..${hi}`);
    result[key] = value;
  }
  return result;
}

/**
 * Записує значення лімітів за замовчуванням у `limit_defaults` (одне джерело для API й воркера);
 * тригер переносить їх у облік тенантів без власних перевизначень.
 */
export async function provisionLimitDefaults(
  query: Query,
  limits: LimitDefaults,
): Promise<void> {
  await query(
    `UPDATE limit_defaults
        SET "maxRunning" = $1, "maxQueueSize" = $2, "rateLimit" = $3, "rateWindowMs" = $4,
            "webhookRateLimit" = $5, "webhookRateWindowMs" = $6
      WHERE id`,
    [
      limits.maxRunning,
      limits.maxQueueSize,
      limits.rateLimit,
      limits.rateWindowMs,
      limits.webhookRateLimit,
      limits.webhookRateWindowMs,
    ],
  );
}

/** Login-ролі процесів з оточення `migrate` (compose) або локального запуску. */
export function loginRolesFromEnv(env: NodeJS.ProcessEnv): LoginRole[] {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`${name} is required for db:provision`);
    return value;
  };
  return [
    {
      user: env.API_DB_USER ?? 'flowforge_api',
      password: required('API_DB_PASSWORD'),
      group: API_ROLE,
    },
    {
      user: env.WORKER_DB_USER ?? 'flowforge_worker',
      password: required('WORKER_DB_PASSWORD'),
      group: WORKER_ROLE,
    },
  ];
}

/** `npm run db:provision`: після migration:run, тим самим власником схеми. */
async function main(): Promise<void> {
  loadDotEnvIfPresent();
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url)
    throw new Error(
      'MIGRATION_DATABASE_URL is required for db:provision: the URL of the schema owner',
    );
  const roles = loginRolesFromEnv(process.env);
  const limits = limitDefaultsFromEnv(process.env);
  const ds = await new DataSource(
    buildDataSourceOptions(
      validateDatabaseEnv({ ...process.env, DATABASE_URL: url }),
      { statementTimeout: false },
    ),
  ).initialize();
  try {
    await ds.transaction(async (em) => {
      const query: Query = (sql, params) => em.query(sql, params);
      await provisionLoginRoles(query, roles);
      await provisionLimitDefaults(query, limits);
    });
  } finally {
    await ds.destroy();
  }
  console.log(
    `database roles provisioned: ${roles.map((r) => r.user).join(', ')}; tenant limit defaults: ${JSON.stringify(limits)}`,
  );
}

if (require.main === module)
  main().catch((err: unknown) => {
    // Лише повідомлення: без стеку й параметрів (у них не буває паролів, але і зайвого не друкуємо).
    console.error(
      'db:provision failed:',
      err instanceof Error ? err.message : 'unknown error',
    );
    process.exit(1);
  });
