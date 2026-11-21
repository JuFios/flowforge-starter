import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  BUILT_IN_LIMIT_DEFAULTS,
  LIMIT_BOUNDS,
  OUTBOX_ATTEMPT_HISTORY,
  OUTBOX_QUOTA_CHECK,
} from '../../tenancy/limits';
import { API_ROLE, SYSTEM_ROLE } from '../../tenancy/roles';

const DEFINER = `SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp`;

/** Ефективні ліміти; ревізія 3 додає `maxOutboxEvents`. */
function tenantLimitsSql(withOutbox: boolean): string {
  return `CREATE FUNCTION public.tenant_limits()
    RETURNS TABLE ("maxRunning" integer, "maxQueueSize" integer, "rateLimit" integer,
                   "rateWindowMs" integer, "webhookRateLimit" integer,
                   "webhookRateWindowMs" integer, "maxWorkflows" integer${withOutbox ? ', "maxOutboxEvents" integer' : ''})
    LANGUAGE plpgsql STABLE ${DEFINER} AS $$
    DECLARE t uuid := public.app_current_tenant();
    BEGIN
      IF t IS NULL THEN RAISE EXCEPTION 'tenant context is required'; END IF;
      RETURN QUERY
        SELECT COALESCE(tn."maxConcurrentExecutions", d."maxRunning"),
               COALESCE(tn."maxQueueSize", d."maxQueueSize"),
               COALESCE(tn."rateLimit", d."rateLimit"), d."rateWindowMs",
               COALESCE(tn."webhookRateLimit", d."webhookRateLimit"), d."webhookRateWindowMs",
               COALESCE(tn."maxWorkflows", d."maxWorkflows")${
                 withOutbox
                   ? `,
               COALESCE(tn."maxOutboxEvents", d."maxOutboxEvents")`
                   : ''
               }
          FROM public.tenants tn CROSS JOIN public.limit_defaults d
         WHERE tn.id = t;
    END $$`;
}

/** Блокування обліку тенанта; ревізія 2 повертає також облік і квоту outbox. */
function lockUsageSql(withOutbox: boolean): string {
  return `CREATE FUNCTION public.lock_tenant_usage()
    RETURNS TABLE (queued integer, running integer, "maxRunning" integer,
                   "maxQueueSize" integer${withOutbox ? ', "outboxUndelivered" integer, "maxOutboxEvents" integer' : ''})
    LANGUAGE plpgsql VOLATILE ${DEFINER} AS $$
    DECLARE
      t uuid := public.app_current_tenant();
      usage public.tenant_usage;
    BEGIN
      IF t IS NULL THEN RAISE EXCEPTION 'tenant context is required'; END IF;
      SELECT u.* INTO STRICT usage
        FROM public.tenant_usage u WHERE u."tenantId" = t FOR UPDATE;
      ${
        withOutbox
          ? `-- Окремий запит після блокування: бачить актуальний стан після очікування.
      RETURN QUERY
        SELECT usage.queued, usage.running, usage."maxRunning", usage."maxQueueSize",
               o.undelivered, COALESCE(tn."maxOutboxEvents", d."maxOutboxEvents")
          FROM public.tenant_outbox_usage o
          JOIN public.tenants tn ON tn.id = o."tenantId"
          CROSS JOIN public.limit_defaults d
         WHERE o."tenantId" = t;
      IF NOT FOUND THEN RAISE EXCEPTION 'tenant outbox usage or defaults are missing'; END IF;`
          : `RETURN QUERY SELECT usage.queued, usage.running, usage."maxRunning", usage."maxQueueSize";`
      }
    END $$`;
}

async function ownFunction(
  runner: QueryRunner,
  signature: string,
  grantee: string | null,
): Promise<void> {
  await runner.query(
    `ALTER FUNCTION public.${signature} OWNER TO ${SYSTEM_ROLE}`,
  );
  await runner.query(`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC`);
  if (grantee)
    await runner.query(
      `GRANT EXECUTE ON FUNCTION public.${signature} TO ${grantee}`,
    );
}

/**
 * Межа ресурсів outbox (ТЗ 3.3.4, 3.3.9, 4; README «Модель гарантій»). Поки endpoint тенанта
 * недоступний, недоставлені події накопичувались без межі сховища.
 *
 * Інваріант: `недоставлені події + живі виконання (queued + running) ≤ maxOutboxEvents`.
 * Завершення перетворює живе виконання щонайбільше на одну подію, тож сума не зростає; її
 * збільшують лише нова постановка (run, webhook, cron), `/retry` і redeliver, і всі вони
 * перевіряють квоту під блокуванням рядка обліку тенанта. Прийнята подія ніколи не видаляється
 * через квоту: заповнена квота зупиняє лише нову роботу тенанта (429 `outbox_full`, cron
 * відкладає), інші тенанти працюють далі.
 *
 * Тригер веде окремий лічильник `tenant_outbox_usage`: доставка і discard не блокують рядок,
 * за яким воркери вибирають тенанта. Збільшення лічильника серіалізується з допуском роботи
 * через `tenant_usage`; якщо потрібні обидва рядки, черга блокується перед лічильником outbox.
 *
 * Історія спроб обмежена `OUTBOX_ATTEMPT_HISTORY` записами на подію (перша й останні), тож за
 * тривалої відмови endpoint-а журнал спроб не росте без межі.
 */
export class OutboxQuota1797100000000 implements MigrationInterface {
  name = 'OutboxQuota1797100000000';

  async up(runner: QueryRunner): Promise<void> {
    const [lo, hi] = LIMIT_BOUNDS.maxOutboxEvents;
    await runner.query(
      'LOCK TABLE public.tenants, public.tenant_usage, public.outbox_events, public.outbox_attempts IN SHARE ROW EXCLUSIVE MODE',
    );
    await runner.query(
      `ALTER TABLE public.tenants ADD "maxOutboxEvents" integer`,
    );
    await runner.query(
      `ALTER TABLE public.tenants ADD CONSTRAINT "${OUTBOX_QUOTA_CHECK.name}" CHECK (${OUTBOX_QUOTA_CHECK.expression})`,
    );
    await runner.query(`ALTER TABLE public.limit_defaults
      ADD "maxOutboxEvents" integer NOT NULL DEFAULT ${BUILT_IN_LIMIT_DEFAULTS.maxOutboxEvents}
      CHECK ("maxOutboxEvents" BETWEEN ${lo} AND ${hi})`);

    await runner.query('DROP FUNCTION public.tenant_limits()');
    await runner.query(tenantLimitsSql(true));
    await ownFunction(runner, 'tenant_limits()', API_ROLE);

    await runner.query(`CREATE TABLE public.tenant_outbox_usage (
      "tenantId" uuid PRIMARY KEY REFERENCES public.tenants(id),
      undelivered integer NOT NULL DEFAULT 0 CHECK (undelivered >= 0)
    )`);
    await runner.query(`INSERT INTO public.tenant_outbox_usage ("tenantId", undelivered)
      SELECT t.id, COALESCE(c.n, 0)
        FROM public.tenants t
        LEFT JOIN (SELECT "tenantId", count(*)::integer AS n FROM public.outbox_events
                    WHERE status IN ('pending', 'sending') GROUP BY "tenantId") c
          ON c."tenantId" = t.id`);
    await runner.query(
      'ALTER TABLE public.tenant_outbox_usage ENABLE ROW LEVEL SECURITY',
    );
    await runner.query(
      'ALTER TABLE public.tenant_outbox_usage FORCE ROW LEVEL SECURITY',
    );
    await runner.query(`CREATE POLICY tenant_isolation ON public.tenant_outbox_usage
      USING ("tenantId" = public.app_current_tenant())
      WITH CHECK ("tenantId" = public.app_current_tenant())`);
    await runner.query('REVOKE ALL ON public.tenant_outbox_usage FROM PUBLIC');
    await runner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_outbox_usage TO ${SYSTEM_ROLE}`,
    );

    await runner.query(`CREATE FUNCTION public.outbox_usage_on_tenant() RETURNS trigger
      LANGUAGE plpgsql ${DEFINER} AS $$
      BEGIN
        INSERT INTO public.tenant_outbox_usage ("tenantId") VALUES (NEW.id);
        RETURN NULL;
      END $$`);
    await ownFunction(runner, 'outbox_usage_on_tenant()', null);
    await runner.query(`CREATE TRIGGER tenant_usage_outbox_insert
      AFTER INSERT ON public.tenants FOR EACH ROW EXECUTE FUNCTION public.outbox_usage_on_tenant()`);

    await runner.query('DROP FUNCTION public.lock_tenant_usage()');
    await runner.query(lockUsageSql(true));
    await ownFunction(runner, 'lock_tenant_usage()', API_ROLE);

    await runner.query(`CREATE FUNCTION public.outbox_usage() RETURNS trigger
      LANGUAGE plpgsql ${DEFINER} AS $$
      DECLARE
        delta integer := 0;
        tenant uuid;
      BEGIN
        IF TG_OP <> 'INSERT' AND OLD.status IN ('pending', 'sending') THEN
          delta := delta - 1; tenant := OLD."tenantId";
        END IF;
        IF TG_OP <> 'DELETE' AND NEW.status IN ('pending', 'sending') THEN
          delta := delta + 1; tenant := NEW."tenantId";
        END IF;
        IF delta > 0 THEN
          PERFORM 1 FROM public.tenant_usage WHERE "tenantId" = tenant FOR UPDATE;
          IF NOT FOUND THEN RAISE EXCEPTION 'tenant usage row is missing'; END IF;
        END IF;
        IF delta <> 0 THEN
          UPDATE public.tenant_outbox_usage SET undelivered = undelivered + delta
            WHERE "tenantId" = tenant;
          IF NOT FOUND THEN RAISE EXCEPTION 'tenant outbox usage row is missing'; END IF;
        END IF;
        RETURN NULL;
      END $$`);
    await ownFunction(runner, 'outbox_usage()', null);
    await runner.query(`CREATE TRIGGER outbox_usage
      AFTER INSERT OR DELETE OR UPDATE OF status ON public.outbox_events
      FOR EACH ROW EXECUTE FUNCTION public.outbox_usage()`);

    await runner.query(`CREATE FUNCTION public.outbox_attempt_history() RETURNS trigger
      LANGUAGE plpgsql ${DEFINER} AS $$
      BEGIN
        -- Перша спроба й останні ${OUTBOX_ATTEMPT_HISTORY - 1} лишаються; старші видаляються.
        DELETE FROM public.outbox_attempts
         WHERE "eventId" = NEW."eventId" AND "tenantId" = NEW."tenantId"
           AND attempt > 1 AND attempt <= NEW.attempt - ${OUTBOX_ATTEMPT_HISTORY - 1};
        RETURN NULL;
      END $$`);
    await ownFunction(runner, 'outbox_attempt_history()', null);
    await runner.query(`CREATE TRIGGER outbox_attempt_history
      AFTER INSERT ON public.outbox_attempts
      FOR EACH ROW WHEN (NEW.attempt > ${OUTBOX_ATTEMPT_HISTORY})
      EXECUTE FUNCTION public.outbox_attempt_history()`);
    // Наявна історія — до тієї самої межі.
    await runner.query(`DELETE FROM public.outbox_attempts a USING public.outbox_events e
      WHERE a."eventId" = e.id AND a.attempt > 1
        AND a.attempt <= e.attempts - ${OUTBOX_ATTEMPT_HISTORY - 1}`);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(
      'DROP TRIGGER outbox_attempt_history ON public.outbox_attempts',
    );
    await runner.query('DROP FUNCTION public.outbox_attempt_history()');
    await runner.query('DROP TRIGGER outbox_usage ON public.outbox_events');
    await runner.query('DROP FUNCTION public.outbox_usage()');
    await runner.query('DROP FUNCTION public.lock_tenant_usage()');
    await runner.query(lockUsageSql(false));
    await ownFunction(runner, 'lock_tenant_usage()', API_ROLE);
    await runner.query(
      'DROP TRIGGER tenant_usage_outbox_insert ON public.tenants',
    );
    await runner.query('DROP FUNCTION public.outbox_usage_on_tenant()');
    await runner.query('DROP TABLE public.tenant_outbox_usage');
    await runner.query('DROP FUNCTION public.tenant_limits()');
    await runner.query(tenantLimitsSql(false));
    await ownFunction(runner, 'tenant_limits()', API_ROLE);
    await runner.query(
      'ALTER TABLE public.limit_defaults DROP COLUMN "maxOutboxEvents"',
    );
    await runner.query(
      `ALTER TABLE public.tenants DROP CONSTRAINT "${OUTBOX_QUOTA_CHECK.name}"`,
    );
    await runner.query(
      'ALTER TABLE public.tenants DROP COLUMN "maxOutboxEvents"',
    );
  }
}
