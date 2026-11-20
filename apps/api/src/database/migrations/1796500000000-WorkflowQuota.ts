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
 * Квота збережених workflow тенанта (беклог PR 6, P1). Перевірка — у тригері БД, тож її не обходить
 * жоден шлях вставки. Advisory-блокування транзакції за тенантом серіалізує вставки одного
 * тенанта: наступна чекає COMMIT попередньої, а її підрахунок (новий знімок READ COMMITTED після
 * блокування) уже бачить той рядок. Гарячий рядок `tenant_usage` (облік claim) не блокується.
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

    await runner.query(`CREATE FUNCTION public.workflow_quota() RETURNS trigger
      LANGUAGE plpgsql ${DEFINER} AS $$
      DECLARE
        quota integer;
        used integer;
      BEGIN
        PERFORM pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended('flowforge.workflow_quota:' || NEW."tenantId"::text, 0));
        SELECT COALESCE(t."maxWorkflows", d."maxWorkflows") INTO quota
          FROM public.tenants t CROSS JOIN public.limit_defaults d
         WHERE t.id = NEW."tenantId";
        IF quota IS NULL THEN RETURN NEW; END IF;
        SELECT count(*) INTO used FROM (
          SELECT 1 FROM public.workflows w WHERE w."tenantId" = NEW."tenantId" LIMIT quota
        ) s;
        IF used >= quota THEN
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
    await runner.query(`CREATE TRIGGER workflow_quota BEFORE INSERT ON public.workflows
      FOR EACH ROW EXECUTE FUNCTION public.workflow_quota()`);

    // Сторінка списку: ORDER BY "createdAt" DESC, id DESC з предикатом курсора — один діапазон індексу.
    await runner.query(`CREATE INDEX "IDX_workflows_tenant_created"
      ON public.workflows ("tenantId", "createdAt" DESC, id DESC)`);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP INDEX public."IDX_workflows_tenant_created"');
    await runner.query('DROP TRIGGER workflow_quota ON public.workflows');
    await runner.query('DROP FUNCTION public.workflow_quota()');
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
