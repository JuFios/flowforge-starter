import 'reflect-metadata';
import { DataSource, Migration, MigrationExecutor } from 'typeorm';
import { validateDatabaseEnv } from '../config/env.validation';
import { assertSecurityPosture } from '../tenancy/security-posture';
import { loadDotEnvIfPresent } from './cli-env';
import { buildDataSourceOptions } from './database.options';

/**
 * Ключ advisory-локу міграцій: два одночасні `db:migrate` (два розгортання, повтор після обриву)
 * виконуються по черзі, а другий бачить уже застосовані міграції й лише звіряє каталог.
 */
export const MIGRATION_LOCK_KEY = 0x666c6f77;

/**
 * Скільки `db:migrate` чекає на лок, який тримає інший запуск. Без межі завислий попередній запуск
 * (чи сесія, що тримає лок) мовчки зупиняв би кожне наступне розгортання.
 */
export const MIGRATION_LOCK_WAIT_MS = 10 * 60_000;
const MIGRATION_LOCK_POLL_MS = 500;

/**
 * Усі невиконані міграції й звірка інваріантів безпеки — в одній транзакції (README, «Міграції БД»).
 * Якщо каталог після міграцій не відповідає `POSTURE` (чужий грант, політика, роль із входом чи
 * сесією), транзакція відкочується: жодне надання, зокрема BYPASSRLS системній ролі, не набуває
 * чинності. Звірка виконується й тоді, коли міграцій немає, тож кожен запуск виявляє дрейф.
 */
export async function migrate(
  ds: DataSource,
  { lockWaitMs = MIGRATION_LOCK_WAIT_MS }: { lockWaitMs?: number } = {},
): Promise<Migration[]> {
  const runner = ds.createQueryRunner();
  await runner.connect();
  try {
    await runner.startTransaction();
    // Спроба без очікування в циклі з межею (lock_timeout діяв би й на блокування DDL міграцій).
    const deadline = Date.now() + lockWaitMs;
    for (;;) {
      const [{ locked }] = (await runner.query(
        'SELECT pg_catalog.pg_try_advisory_xact_lock($1) AS locked',
        [MIGRATION_LOCK_KEY],
      )) as Array<{ locked: boolean }>;
      if (locked) break;
      if (Date.now() >= deadline)
        throw new Error(
          `another db:migrate has held the migration lock for over ${Math.round(lockWaitMs / 1000)} s; check for a stuck migration session`,
        );
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(MIGRATION_LOCK_POLL_MS, lockWaitMs)),
      );
    }
    const executor = new MigrationExecutor(ds, runner);
    // Транзакцію вже відкрито тут: виконавець не відкриває й не завершує власних.
    executor.transaction = 'none';
    const applied = await executor.executePendingMigrations();
    await assertSecurityPosture((sql, params) => runner.query(sql, params));
    await runner.commitTransaction();
    return applied;
  } catch (err) {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    throw err;
  } finally {
    await runner.release();
  }
}

/** `npm run db:migrate`: власником схеми (MIGRATION_DATABASE_URL), до `db:provision`. */
async function main(): Promise<void> {
  loadDotEnvIfPresent();
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url)
    throw new Error(
      'MIGRATION_DATABASE_URL is required for db:migrate: the URL of the schema owner (a PostgreSQL superuser)',
    );
  // Як CLI міграцій: без statement_timeout (довгі ALTER TABLE).
  const ds = await new DataSource(
    buildDataSourceOptions(
      validateDatabaseEnv({ ...process.env, DATABASE_URL: url }),
      { statementTimeout: false },
    ),
  ).initialize();
  try {
    const applied = await migrate(ds);
    console.log(
      `migrations applied: ${applied.length ? applied.map((m) => m.name).join(', ') : 'none'}; security posture verified`,
    );
  } finally {
    await ds.destroy();
  }
}

if (require.main === module)
  main().catch((err: unknown) => {
    // Лише повідомлення: імена об'єктів і ролей, без параметрів підключення.
    console.error(
      'db:migrate failed:',
      err instanceof Error ? err.message : 'unknown error',
    );
    process.exit(1);
  });
