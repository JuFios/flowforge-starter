import type { DataSource } from 'typeorm';

/** Бар'єр тримає один рядок чекпоінта. Воркер, що чекає на цей рядок, чекає завершення транзакції бар'єра. */
export async function checkpointWriteIsBlocked(
  db: Pick<DataSource, 'query'>,
  gatePid: number,
): Promise<boolean> {
  const [{ waiting }] = await db.query<Array<{ waiting: boolean }>>(
    `SELECT EXISTS (
       SELECT FROM pg_locks held
       JOIN pg_locks pending
         ON pending.locktype = 'transactionid'
        AND pending.transactionid = held.transactionid
        AND pending.mode = 'ShareLock' AND NOT pending.granted
       JOIN pg_stat_activity worker ON worker.pid = pending.pid
       JOIN pg_roles login_role ON login_role.oid = worker.usesysid
       WHERE held.pid = $1 AND held.locktype = 'transactionid'
         AND held.mode = 'ExclusiveLock' AND held.granted
         AND worker.datname = current_database()
         AND worker.backend_type = 'client backend'
         AND NOT login_role.rolsuper
         AND pg_has_role(worker.usesysid, 'flowforge_worker_role', 'MEMBER')
         AND $1 = ANY(pg_blocking_pids(worker.pid))
     ) AS waiting`,
    [gatePid],
  );
  return waiting;
}
