import { DataSource, QueryRunner } from 'typeorm';
import { waitFor } from './wait-for';

/** Чекає, доки інше з’єднання справді потребує блокування цієї транзакції. */
export async function waitForBlocked(
  ds: DataSource,
  holder: QueryRunner,
  count = 1,
): Promise<void> {
  const [{ pid }] = (await holder.query(
    'SELECT pg_backend_pid() AS pid',
  )) as Array<{ pid: number }>;
  await waitFor(
    'blocked PostgreSQL transaction',
    async () => {
      const [{ waiting }] = await ds.query<Array<{ waiting: number }>>(
        'SELECT count(*)::integer AS waiting FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
        [pid],
      );
      return waiting >= count;
    },
    { timeoutMs: 5000, intervalMs: 10 },
  );
}
