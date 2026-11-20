/** Викликати в транзакції до читання чи зміни ролей. Каталог спільний для всіх БД кластера. */
export async function lockClusterRoles(
  query: (sql: string) => Promise<unknown>,
): Promise<void> {
  await query(`DO $lock$
    DECLARE previous_timeout text := current_setting('lock_timeout');
    BEGIN
      IF previous_timeout='0' THEN PERFORM set_config('lock_timeout','10min',true); END IF;
      LOCK TABLE pg_catalog.pg_authid IN SHARE ROW EXCLUSIVE MODE;
      PERFORM set_config('lock_timeout',previous_timeout,true);
    END $lock$`);
}
