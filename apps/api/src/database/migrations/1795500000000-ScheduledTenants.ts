import { MigrationInterface, QueryRunner } from 'typeorm';
import { API_ROLE, SYSTEM_ROLE } from '../../tenancy/roles';

export class ScheduledTenants1795500000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(
      `CREATE INDEX "IDX_workflows_scheduled_tenant" ON public.workflows ("tenantId", id) WHERE enabled AND cron IS NOT NULL`,
    );
    await runner.query(`CREATE FUNCTION public.scheduled_tenants(p_after uuid,p_limit integer)
      RETURNS TABLE ("tenantId" uuid) LANGUAGE sql STABLE SECURITY DEFINER
      SET search_path = pg_catalog, public, pg_temp AS $$
        SELECT t.id FROM public.tenants t
        WHERE (p_after IS NULL OR t.id > p_after)
          AND EXISTS (SELECT FROM public.workflows w WHERE w."tenantId"=t.id AND w.enabled AND w.cron IS NOT NULL)
        ORDER BY t.id LIMIT LEAST(GREATEST(p_limit,1),1000)
      $$`);
    await runner.query(
      `ALTER FUNCTION public.scheduled_tenants(uuid,integer) OWNER TO ${SYSTEM_ROLE}`,
    );
    await runner.query(
      'REVOKE ALL ON FUNCTION public.scheduled_tenants(uuid,integer) FROM PUBLIC',
    );
    await runner.query(
      `GRANT EXECUTE ON FUNCTION public.scheduled_tenants(uuid,integer) TO ${API_ROLE}`,
    );
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP FUNCTION public.scheduled_tenants(uuid,integer)');
    await runner.query('DROP INDEX public."IDX_workflows_scheduled_tenant"');
  }
}
