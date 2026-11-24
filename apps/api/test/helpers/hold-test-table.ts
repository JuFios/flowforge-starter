import { DataSource } from 'typeorm';
import { waitFor } from './wait-for';

/** Бар'єр для фонового запиту. Рядки й дані таблиці лишаються без змін. */
export async function holdTestTable(
  ds: DataSource,
  table: 'step_runs' | 'notification_settings',
) {
  const gate = ds.createQueryRunner();
  const release = async () => {
    try {
      if (gate.isTransactionActive) await gate.rollbackTransaction();
    } finally {
      await gate.release();
    }
  };
  try {
    await gate.startTransaction();
    await gate.query("SET LOCAL statement_timeout = '5s'");
    await gate.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
    const [{ pid }] = await gate.manager.query<Array<{ pid: number }>>(
      'SELECT pg_backend_pid() AS pid',
    );
    return {
      release,
      async waitForQuery(prefix: string) {
        await waitFor(`background query on ${table}`, async () => {
          const [{ waiting }] = await ds.query<Array<{ waiting: boolean }>>(
            `SELECT EXISTS (
               SELECT FROM pg_stat_activity
                WHERE datname = current_database()
                  AND wait_event_type = 'Lock'
                  AND starts_with(query, $2)
                  AND $1 = ANY(pg_blocking_pids(pid))
             ) AS waiting`,
            [pid, prefix],
          );
          return waiting;
        });
      },
    };
  } catch (error) {
    await release();
    throw error;
  }
}
