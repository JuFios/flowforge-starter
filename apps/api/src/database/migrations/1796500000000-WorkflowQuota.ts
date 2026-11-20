import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  BUILT_IN_LIMIT_DEFAULTS,
  LIMIT_BOUNDS,
  WORKFLOW_QUOTA_CHECK,
  WORKFLOW_QUOTA_SQLSTATE,
} from '../../tenancy/limits';
import { API_ROLE, SYSTEM_ROLE } from '../../tenancy/roles';

const DEFINER = `SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp`;

/** Ефективні ліміти; ревізія 2 додає `maxWorkflows`. */
function tenantLimitsSql(withWorkflows: boolean): string {
  return `CREATE FUNCTION public.tenant_limits()
    RETURNS TABLE ("maxRunning" integer, "maxQueueSize" integer, "rateLimit" integer,
                   "rateWindowMs" integer, "webhookRateLimit" integer,
                   "webhookRateWindowMs" integer${withWorkflows ? ', "maxWorkflows" integer' : ''})
    LANGUAGE plpgsql STABLE ${DEFINER} AS $$
    DECLARE t uuid := public.app_current_tenant();
    BEGIN
      IF t IS NULL THEN RAISE EXCEPTION 'tenant context is required'; END IF;
      RETURN QUERY
        SELECT COALESCE(tn."maxConcurrentExecutions", d."maxRunning"),
               COALESCE(tn."maxQueueSize", d."maxQueueSize"),
               COALESCE(tn."rateLimit", d."rateLimit"), d."rateWindowMs",
               COALESCE(tn."webhookRateLimit", d."webhookRateLimit"), d."webhookRateWindowMs"${
                 withWorkflows
                   ? `,
               COALESCE(tn."maxWorkflows", d."maxWorkflows")`
                   : ''
               }
          FROM public.tenants tn CROSS JOIN public.limit_defaults d
         WHERE tn.id = t;
    END $$`;
}

/**
 * Облік workflow серіалізовано одним рядком на тенанта. Лічильник створюється при першій
 * вставці, відмова за квотою відкочує і вставку, і приріст. Облік черги не блокується.
 */
export class WorkflowQuota1796500000000 implements MigrationInterface {
  name = 'WorkflowQuota1796500000000';

  async up(runner: QueryRunner): Promise<void> {
    const [lo, hi] = LIMIT_BOUNDS.maxWorkflows;
    await runner.query(`ALTER TABLE public.tenants ADD "maxWorkflows" integer`);
    await runner.query(
      `ALTER TABLE public.tenants ADD CONSTRAINT "${WORKFLOW_QUOTA_CHECK.name}" CHECK (${WORKFLOW_QUOTA_CHECK.expression})`,
    );
    await runner.query(`ALTER TABLE public.limit_defaults
      ADD "maxWorkflows" integer NOT NULL DEFAULT ${BUILT_IN_LIMIT_DEFAULTS.maxWorkflows}
      CHECK ("maxWorkflows" BETWEEN ${lo} AND ${hi})`);

    await runner.query('DROP FUNCTION public.tenant_limits()');
    await runner.query(tenantLimitsSql(true));
    await runner.query(
      `ALTER FUNCTION public.tenant_limits() OWNER TO ${SYSTEM_ROLE}`,
    );
    await runner.query(
      'REVOKE ALL ON FUNCTION public.tenant_limits() FROM PUBLIC',
    );
    await runner.query(
      `GRANT EXECUTE ON FUNCTION public.tenant_limits() TO ${API_ROLE}`,
    );

    await runner.query(`CREATE TABLE public.workflow_usage (
      "tenantId" uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
      used bigint NOT NULL CHECK (used >= 0))`);
    await runner.query(
      `INSERT INTO public.workflow_usage SELECT "tenantId",count(*) FROM public.workflows GROUP BY "tenantId"`,
    );
    await runner.query(
      'ALTER TABLE public.workflow_usage ENABLE ROW LEVEL SECURITY',
    );
    await runner.query(
      'ALTER TABLE public.workflow_usage FORCE ROW LEVEL SECURITY',
    );
    await runner.query(
      `CREATE POLICY tenant_isolation ON public.workflow_usage USING ("tenantId"=public.app_current_tenant()) WITH CHECK ("tenantId"=public.app_current_tenant())`,
    );
    await runner.query(
      `GRANT SELECT,INSERT,UPDATE ON public.workflow_usage TO ${SYSTEM_ROLE}`,
    );
    await runner.query(`CREATE FUNCTION public.workflow_quota() RETURNS trigger
      LANGUAGE plpgsql ${DEFINER} AS $$
      DECLARE quota integer; total bigint;
      BEGIN
        IF TG_OP='DELETE' THEN
          UPDATE public.workflow_usage SET used=used-1 WHERE "tenantId"=OLD."tenantId";
          RETURN OLD;
        END IF;
        INSERT INTO public.workflow_usage AS u ("tenantId",used) VALUES (NEW."tenantId",1)
          ON CONFLICT ("tenantId") DO UPDATE SET used=u.used+1 RETURNING used INTO total;
        SELECT COALESCE(t."maxWorkflows", d."maxWorkflows") INTO STRICT quota
          FROM public.tenants t CROSS JOIN public.limit_defaults d WHERE t.id=NEW."tenantId";
        IF total>quota THEN
          RAISE EXCEPTION USING ERRCODE = '${WORKFLOW_QUOTA_SQLSTATE}',
            MESSAGE = 'workflow quota reached', DETAIL = quota::text;
        END IF;
        RETURN NEW;
      END $$`);
    await runner.query(
      `ALTER FUNCTION public.workflow_quota() OWNER TO ${SYSTEM_ROLE}`,
    );
    await runner.query(
      'REVOKE ALL ON FUNCTION public.workflow_quota() FROM PUBLIC',
    );
    await runner.query(`CREATE TRIGGER workflow_quota AFTER INSERT OR DELETE ON public.workflows
      FOR EACH ROW EXECUTE FUNCTION public.workflow_quota()`);

    // Сторінка списку: ORDER BY "createdAt" DESC, id DESC з предикатом курсора — один діапазон індексу.
    await runner.query(`CREATE INDEX "IDX_workflows_tenant_created"
      ON public.workflows ("tenantId", "createdAt" DESC, id DESC)`);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP INDEX public."IDX_workflows_tenant_created"');
    await runner.query('DROP TRIGGER workflow_quota ON public.workflows');
    await runner.query('DROP FUNCTION public.workflow_quota()');
    await runner.query('DROP TABLE public.workflow_usage');
    await runner.query('DROP FUNCTION public.tenant_limits()');
    await runner.query(tenantLimitsSql(false));
    await runner.query(
      `ALTER FUNCTION public.tenant_limits() OWNER TO ${SYSTEM_ROLE}`,
    );
    await runner.query(
      'REVOKE ALL ON FUNCTION public.tenant_limits() FROM PUBLIC',
    );
    await runner.query(
      `GRANT EXECUTE ON FUNCTION public.tenant_limits() TO ${API_ROLE}`,
    );
    await runner.query(
      'ALTER TABLE public.limit_defaults DROP COLUMN "maxWorkflows"',
    );
    await runner.query(
      `ALTER TABLE public.tenants DROP CONSTRAINT "${WORKFLOW_QUOTA_CHECK.name}"`,
    );
    await runner.query('ALTER TABLE public.tenants DROP COLUMN "maxWorkflows"');
  }
}
