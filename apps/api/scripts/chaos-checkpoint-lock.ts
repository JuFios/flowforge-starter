import type { DataSource } from 'typeorm';

export async function checkpointWriteIsBlocked(
  db: Pick<DataSource, 'query'>,
  gatePid: number,
): Promise<boolean> {
  const [{ waiting }] = await db.query<Array<{ waiting: boolean }>>(
    `SELECT EXISTS(SELECT FROM pg_stat_activity
      WHERE $1=ANY(pg_blocking_pids(pid))
        AND wait_event_type = 'Lock'
        AND query LIKE 'UPDATE step_runs SET status = ''succeeded''%') AS waiting`,
    [gatePid],
  );
  return waiting;
}
