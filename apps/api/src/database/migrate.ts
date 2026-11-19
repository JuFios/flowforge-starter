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
 * Усі невиконані міграції й звірка інваріантів безпеки — в одній транзакції (README, «Міграції БД»).
 * Якщо каталог після міграцій не відповідає `POSTURE` (чужий грант, політика, роль із входом чи
 * сесією), транзакція відкочується: жодне надання, зокрема BYPASSRLS системній ролі, не набуває
 * чинності. Звірка виконується й тоді, коли міграцій немає, тож кожен запуск виявляє дрейф.
 */
export async function migrate(ds: DataSource): Promise<Migration[]> {
  const runner = ds.createQueryRunner();
  await runner.connect();
  try {
    await runner.startTransaction();
    await runner.query('SELECT pg_catalog.pg_advisory_xact_lock($1)', [
      MIGRATION_LOCK_KEY,
    ]);
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
