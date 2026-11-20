import { MigrationInterface, QueryRunner } from 'typeorm';
import { API_ROLE, SYSTEM_ROLE } from '../../tenancy/roles';

const DEFINER = `SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp`;

/**
 * Прогрес планувальника в рядку workflow (README 3.3.8): курсор останнього обробленого моменту,
 * політика пропущених запусків і підказка наступного моменту з частковим індексом, тож тік
 * торкається лише належних розкладів. Наявні розклади стартують із моменту міграції: попередня
 * версія не зберігала прогресу, тож моменти до оновлення не наздоганяються.
 */
export class ScheduleProgress1796100000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE public.workflows
      ADD "scheduleCursor" timestamptz NOT NULL DEFAULT now(),
      ADD "missedRunPolicy" varchar NOT NULL DEFAULT 'run_once',
      ADD "nextFireAt" timestamptz,
      ADD "scheduleBlockedSince" timestamptz,
      ADD "scheduleError" text,
      ADD CONSTRAINT "CHK_workflows_missed_run_policy"
        CHECK ("missedRunPolicy" IN ('skip', 'run_once', 'run_all'))`);
    await runner.query(
      `UPDATE public.workflows SET "nextFireAt" = now() WHERE cron IS NOT NULL`,
    );
    await runner.query(
      `CREATE INDEX "IDX_workflows_due" ON public.workflows ("nextFireAt")
        WHERE enabled AND cron IS NOT NULL AND "nextFireAt" IS NOT NULL`,
    );
    await runner.query(`CREATE FUNCTION public.due_schedule_tenants(p_after uuid, p_limit integer)
      RETURNS TABLE ("tenantId" uuid) LANGUAGE sql STABLE ${DEFINER} AS $$
        SELECT DISTINCT w."tenantId" FROM public.workflows w
         WHERE w.enabled AND w.cron IS NOT NULL AND w."nextFireAt" <= pg_catalog.now()
           AND (p_after IS NULL OR w."tenantId" > p_after)
         ORDER BY w."tenantId"
         LIMIT LEAST(GREATEST(p_limit, 1), 1000)
      $$`);
    await runner.query(
      `ALTER FUNCTION public.due_schedule_tenants(uuid,integer) OWNER TO ${SYSTEM_ROLE}`,
    );
    await runner.query(
      'REVOKE ALL ON FUNCTION public.due_schedule_tenants(uuid,integer) FROM PUBLIC',
    );
    await runner.query(
      `GRANT EXECUTE ON FUNCTION public.due_schedule_tenants(uuid,integer) TO ${API_ROLE}`,
    );
    // Попередні сторінки планувальника: усі розклади на кожному тіку. scheduled_workflows не
    // використовувалась із PR 3, але віддавала ролі API ідентифікатори workflow усіх тенантів.
    await runner.query('DROP FUNCTION public.scheduled_tenants(uuid,integer)');
    await runner.query(
      'DROP FUNCTION public.scheduled_workflows(uuid,integer)',
    );
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE FUNCTION public.scheduled_workflows(p_after uuid, p_limit integer)
      RETURNS TABLE (id uuid, "tenantId" uuid)
      LANGUAGE sql STABLE ${DEFINER} AS $$
        SELECT w.id, w."tenantId" FROM public.workflows w
         WHERE w.enabled AND w.cron IS NOT NULL AND (p_after IS NULL OR w.id > p_after)
         ORDER BY w.id
         LIMIT LEAST(GREATEST(p_limit, 1), 1000)
      $$`);
    await runner.query(`CREATE FUNCTION public.scheduled_tenants(p_after uuid,p_limit integer)
      RETURNS TABLE ("tenantId" uuid) LANGUAGE sql STABLE SECURITY DEFINER
      SET search_path = pg_catalog, public, pg_temp AS $$
        SELECT t.id FROM public.tenants t
        WHERE (p_after IS NULL OR t.id > p_after)
          AND EXISTS (SELECT FROM public.workflows w WHERE w."tenantId"=t.id AND w.enabled AND w.cron IS NOT NULL)
        ORDER BY t.id LIMIT LEAST(GREATEST(p_limit,1),1000)
      $$`);
    for (const signature of [
      'scheduled_workflows(uuid,integer)',
      'scheduled_tenants(uuid,integer)',
    ]) {
      await runner.query(
        `ALTER FUNCTION public.${signature} OWNER TO ${SYSTEM_ROLE}`,
      );
      await runner.query(
        `REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC`,
      );
      await runner.query(
        `GRANT EXECUTE ON FUNCTION public.${signature} TO ${API_ROLE}`,
      );
    }
    await runner.query(
      'DROP FUNCTION public.due_schedule_tenants(uuid,integer)',
    );
    await runner.query('DROP INDEX public."IDX_workflows_due"');
    await runner.query(`ALTER TABLE public.workflows
      DROP CONSTRAINT "CHK_workflows_missed_run_policy",
      DROP COLUMN "scheduleError",
      DROP COLUMN "scheduleBlockedSince",
      DROP COLUMN "nextFireAt",
      DROP COLUMN "missedRunPolicy",
      DROP COLUMN "scheduleCursor"`);
  }
}
