import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  BUILT_IN_LIMIT_DEFAULTS,
  LIMIT_BOUNDS,
  TENANT_LIMIT_CHECKS,
} from '../../tenancy/limits';
import { API_ROLE, SYSTEM_ROLE, WORKER_ROLE } from '../../tenancy/roles';

/** Спільні атрибути SECURITY DEFINER-функцій: pg_temp — явно останнім (документація Postgres). */
const DEFINER = `SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp`;

const FUNCTIONS: Array<{ signature: string; grantees: string[]; sql: string }> =
  [
    {
      // Блокування рядка обліку тенанта з контексту транзакції (до кінця транзакції). Серіалізує
      // постановки й захоплення одного тенанта; без контексту — помилка.
      signature: 'lock_tenant_usage()',
      grantees: [API_ROLE, WORKER_ROLE],
      sql: `CREATE FUNCTION public.lock_tenant_usage()
        RETURNS TABLE (queued integer, running integer, "maxRunning" integer,
                       "maxQueueSize" integer, due boolean, "lastClaimedAt" text)
        LANGUAGE plpgsql VOLATILE ${DEFINER} AS $$
        DECLARE t uuid := public.app_current_tenant();
        BEGIN
          IF t IS NULL THEN RAISE EXCEPTION 'tenant context is required'; END IF;
          RETURN QUERY
            SELECT u.queued, u.running, u."maxRunning", u."maxQueueSize",
                   COALESCE(u."nextRunAt" <= pg_catalog.clock_timestamp(), false),
                   u."lastClaimedAt"::text
              FROM public.tenant_usage u WHERE u."tenantId" = t FOR UPDATE;
          IF NOT FOUND THEN RAISE EXCEPTION 'tenant usage row is missing'; END IF;
        END $$`,
    },
    {
      // Самовідновлення: рядок обліку тенанта з контексту — з фактичних задач.
      signature: 'refresh_tenant_usage()',
      grantees: [WORKER_ROLE],
      sql: `CREATE FUNCTION public.refresh_tenant_usage() RETURNS void
        LANGUAGE plpgsql VOLATILE ${DEFINER} AS $$
        DECLARE t uuid := public.app_current_tenant();
        BEGIN
          IF t IS NULL THEN RAISE EXCEPTION 'tenant context is required'; END IF;
          UPDATE public.tenant_usage u
             SET queued = a.queued, running = a.running, "nextRunAt" = a.next,
                 ready = COALESCE(a.next <= pg_catalog.clock_timestamp(), false)
            FROM (SELECT count(*) FILTER (WHERE j.status = 'queued')::int AS queued,
                         count(*) FILTER (WHERE j.status = 'running')::int AS running,
                         min(j."runAt") FILTER (WHERE j.status = 'queued') AS next
                    FROM public.jobs j WHERE j."tenantId" = t) a
           WHERE u."tenantId" = t;
        END $$`,
    },
    {
      // Час минає: тенанти, чия найраніша задача вже настала, стають членами індексу готових.
      // Лише прапорець (не умова коректності — див. claim_candidate), тому SKIP LOCKED.
      signature: 'promote_ready_tenants(integer)',
      grantees: [WORKER_ROLE],
      sql: `CREATE FUNCTION public.promote_ready_tenants(p_batch integer) RETURNS integer
        LANGUAGE plpgsql VOLATILE ${DEFINER} AS $$
        DECLARE promoted integer;
        BEGIN
          UPDATE public.tenant_usage u SET ready = true
           WHERE u."tenantId" IN (
                   SELECT m."tenantId" FROM public.tenant_usage m
                    WHERE NOT m.ready AND m."nextRunAt" <= pg_catalog.clock_timestamp()
                    ORDER BY m."nextRunAt"
                    LIMIT LEAST(GREATEST(p_batch, 1), 1000)
                    FOR UPDATE SKIP LOCKED)
             AND NOT u.ready AND u."nextRunAt" <= pg_catalog.clock_timestamp();
          GET DIAGNOSTICS promoted = ROW_COUNT;
          RETURN promoted;
        END $$`,
    },
    {
      // Найкращий кандидат на захоплення: серед готових і ненасичених — найменше задач у роботі,
      // далі той, кого найдавніше обслужили. Дві гілки: (a) уже просунуті — частковий індекс у
      // порядку ключа; (b) дозрілі, але ще не просунуті — щоб відставання промоції не пропускало
      // нікого. Без блокувань: захоплення далі чекає рядка кандидата й перевіряє свіжість.
      signature: 'claim_candidate(uuid[])',
      grantees: [WORKER_ROLE],
      sql: `CREATE FUNCTION public.claim_candidate(p_exclude uuid[])
        RETURNS TABLE ("tenantId" uuid, "lastClaimedAt" text)
        LANGUAGE sql VOLATILE ${DEFINER} AS $$
          SELECT c."tenantId", c."lastClaimedAt"::text FROM (
            (SELECT u."tenantId", u.running, u."lastClaimedAt" FROM public.tenant_usage u
              WHERE u.ready AND u.running < u."maxRunning"
                AND u."tenantId" <> ALL (COALESCE(p_exclude, '{}'))
              ORDER BY u.running, u."lastClaimedAt", u."tenantId"
              LIMIT 1)
            UNION ALL
            (SELECT u."tenantId", u.running, u."lastClaimedAt" FROM public.tenant_usage u
              WHERE NOT u.ready AND u."nextRunAt" <= pg_catalog.clock_timestamp()
                AND u.running < u."maxRunning"
                AND u."tenantId" <> ALL (COALESCE(p_exclude, '{}'))
              ORDER BY u.running, u."lastClaimedAt", u."tenantId"
              LIMIT 1)
          ) c
          ORDER BY c.running, c."lastClaimedAt", c."tenantId"
          LIMIT 1
        $$`,
    },
    {
      // Метрика глибини черги: лише тенанти з незавершеними задачами, без даних.
      signature: 'queue_depth_by_tenant()',
      grantees: [WORKER_ROLE],
      sql: `CREATE FUNCTION public.queue_depth_by_tenant()
        RETURNS TABLE ("tenantId" uuid, queued integer, running integer)
        LANGUAGE sql STABLE ${DEFINER} AS $$
          SELECT u."tenantId", u.queued, u.running FROM public.tenant_usage u
           WHERE u.queued > 0 OR u.running > 0
        $$`,
    },
  ];

/** Тригерні функції (власник — системна роль): лише вони змінюють tenant_usage. */
const TRIGGER_FUNCTIONS = [
  {
    name: 'tenant_usage_on_job',
    // Облік задач тенанта в тій самій транзакції, що й зміна задачі: лічильники станів, найраніша
    // задача в черзі (nextRunAt), готовість і момент останнього захоплення. Пише рядок, лише коли
    // щось справді змінилось.
    sql: `CREATE FUNCTION public.tenant_usage_on_job() RETURNS trigger
      LANGUAGE plpgsql ${DEFINER} AS $$
      DECLARE
        t uuid;
        old_queued boolean := TG_OP <> 'INSERT' AND OLD.status = 'queued';
        new_queued boolean := TG_OP <> 'DELETE' AND NEW.status = 'queued';
        old_running boolean := TG_OP <> 'INSERT' AND OLD.status = 'running';
        new_running boolean := TG_OP <> 'DELETE' AND NEW.status = 'running';
        claimed boolean := TG_OP = 'UPDATE' AND OLD.status = 'queued' AND NEW.status = 'running';
        current_next timestamptz;
        next_run timestamptz;
      BEGIN
        IF TG_OP = 'UPDATE' AND NEW."tenantId" IS DISTINCT FROM OLD."tenantId" THEN
          RAISE EXCEPTION 'jobs.tenantId cannot change';
        END IF;
        IF NOT (old_queued OR new_queued OR old_running OR new_running) THEN
          RETURN NULL;
        END IF;
        t := CASE WHEN TG_OP = 'DELETE' THEN OLD."tenantId" ELSE NEW."tenantId" END;
        SELECT u."nextRunAt" INTO current_next FROM public.tenant_usage u
         WHERE u."tenantId" = t FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'tenant usage row is missing';
        END IF;
        next_run := current_next;
        IF old_queued AND current_next IS NOT NULL AND OLD."runAt" <= current_next
           AND NOT (new_queued AND NEW."runAt" <= OLD."runAt") THEN
          -- Найранішу задачу забрали або відсунули: мінімум за індексом (тригер AFTER бачить
          -- стан таблиці після оператора).
          SELECT min(j."runAt") INTO next_run FROM public.jobs j
           WHERE j."tenantId" = t AND j.status = 'queued';
        ELSIF new_queued THEN
          next_run := LEAST(current_next, NEW."runAt");
        END IF;
        UPDATE public.tenant_usage u
           SET queued = u.queued + (new_queued::int - old_queued::int),
               running = u.running + (new_running::int - old_running::int),
               "nextRunAt" = next_run,
               ready = COALESCE(next_run <= pg_catalog.clock_timestamp(), false),
               "lastClaimedAt" = CASE WHEN claimed THEN pg_catalog.clock_timestamp()
                                      ELSE u."lastClaimedAt" END
         WHERE u."tenantId" = t
           AND (new_queued IS DISTINCT FROM old_queued
                OR new_running IS DISTINCT FROM old_running
                OR next_run IS DISTINCT FROM current_next
                OR claimed);
        RETURN NULL;
      END $$`,
  },
  {
    name: 'tenant_usage_on_tenant',
    // Новий тенант — рядок обліку з ефективними лімітами; зміна перевизначень — нові ліміти.
    // Новий тенант стає в кінець черговості (lastClaimedAt = момент створення).
    sql: `CREATE FUNCTION public.tenant_usage_on_tenant() RETURNS trigger
      LANGUAGE plpgsql ${DEFINER} AS $$
      DECLARE d public.limit_defaults;
      BEGIN
        SELECT * INTO d FROM public.limit_defaults WHERE id;
        IF TG_OP = 'INSERT' THEN
          INSERT INTO public.tenant_usage ("tenantId", "maxRunning", "maxQueueSize")
          VALUES (NEW.id, COALESCE(NEW."maxConcurrentExecutions", d."maxRunning"),
                  COALESCE(NEW."maxQueueSize", d."maxQueueSize"));
        ELSE
          UPDATE public.tenant_usage u
             SET "maxRunning" = COALESCE(NEW."maxConcurrentExecutions", d."maxRunning"),
                 "maxQueueSize" = COALESCE(NEW."maxQueueSize", d."maxQueueSize")
           WHERE u."tenantId" = NEW.id;
        END IF;
        RETURN NULL;
      END $$`,
  },
  {
    name: 'tenant_usage_on_defaults',
    // Нові значення за замовчуванням — тенантам без перевизначень.
    sql: `CREATE FUNCTION public.tenant_usage_on_defaults() RETURNS trigger
      LANGUAGE plpgsql ${DEFINER} AS $$
      BEGIN
        UPDATE public.tenant_usage u
           SET "maxRunning" = COALESCE(t."maxConcurrentExecutions", NEW."maxRunning"),
               "maxQueueSize" = COALESCE(t."maxQueueSize", NEW."maxQueueSize")
          FROM public.tenants t
         WHERE t.id = u."tenantId"
           AND (u."maxRunning", u."maxQueueSize") IS DISTINCT FROM
               (COALESCE(t."maxConcurrentExecutions", NEW."maxRunning"),
                COALESCE(t."maxQueueSize", NEW."maxQueueSize"));
        RETURN NULL;
      END $$`,
  },
];

/**
 * Облік тенантів для справедливого захоплення і лімітів (ТЗ 3.3.4–3.3.5): `tenant_usage` (рядок
 * на тенанта, змінюють лише тригери), значення лімітів за замовчуванням (`limit_defaults`, пише
 * db:provision) і перевизначення в `tenants`.
 */
export class TenantUsage1795200000000 implements MigrationInterface {
  name = 'TenantUsage1795200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const d = BUILT_IN_LIMIT_DEFAULTS;
    const b = LIMIT_BOUNDS;
    const between = (column: string, [lo, hi]: readonly [number, number]) =>
      `"${column}" BETWEEN ${lo} AND ${hi}`;

    await queryRunner.query(`
      CREATE TABLE "limit_defaults" (
        "id" boolean PRIMARY KEY DEFAULT true CHECK ("id"),
        "maxRunning" integer NOT NULL CHECK (${between('maxRunning', b.maxRunning)}),
        "maxQueueSize" integer NOT NULL CHECK (${between('maxQueueSize', b.maxQueueSize)}),
        "rateLimit" integer NOT NULL CHECK (${between('rateLimit', b.rateLimit)}),
        "rateWindowMs" integer NOT NULL CHECK (${between('rateWindowMs', b.rateWindowMs)}),
        "webhookRateLimit" integer NOT NULL CHECK (${between('webhookRateLimit', b.rateLimit)}),
        "webhookRateWindowMs" integer NOT NULL CHECK (${between('webhookRateWindowMs', b.rateWindowMs)})
      )`);
    await queryRunner.query(
      `INSERT INTO "limit_defaults" ("maxRunning", "maxQueueSize", "rateLimit", "rateWindowMs",
                                     "webhookRateLimit", "webhookRateWindowMs")
       VALUES (${d.maxRunning}, ${d.maxQueueSize}, ${d.rateLimit}, ${d.rateWindowMs},
               ${d.webhookRateLimit}, ${d.webhookRateWindowMs})`,
    );

    // Перевизначення лімітів тенанта (NULL — значення за замовчуванням).
    await queryRunner.query(`ALTER TABLE "tenants"
      ADD "maxConcurrentExecutions" integer,
      ADD "maxQueueSize" integer,
      ADD "rateLimit" integer,
      ADD "webhookRateLimit" integer`);
    for (const [name, expression] of Object.entries(TENANT_LIMIT_CHECKS))
      await queryRunner.query(
        `ALTER TABLE "tenants" ADD CONSTRAINT "${name}" CHECK (${expression})`,
      );

    await queryRunner.query(`
      CREATE TABLE "tenant_usage" (
        "tenantId" uuid PRIMARY KEY REFERENCES "tenants"("id"),
        "queued" integer NOT NULL DEFAULT 0 CHECK ("queued" >= 0),
        "running" integer NOT NULL DEFAULT 0 CHECK ("running" >= 0),
        "nextRunAt" timestamptz,
        "ready" boolean NOT NULL DEFAULT false,
        "maxRunning" integer NOT NULL,
        "maxQueueSize" integer NOT NULL,
        "lastClaimedAt" timestamptz NOT NULL DEFAULT clock_timestamp()
      )`);
    // Кандидати на захоплення: лише готові й ненасичені, у порядку ключа вибору.
    await queryRunner.query(
      `CREATE INDEX "IDX_tenant_usage_claim" ON "tenant_usage" ("running", "lastClaimedAt", "tenantId")
        WHERE "ready" AND "running" < "maxRunning"`,
    );
    // Дозрілі, ще не просунуті тенанти (промоція й гілка (b) вибору кандидата).
    await queryRunner.query(
      `CREATE INDEX "IDX_tenant_usage_maturing" ON "tenant_usage" ("nextRunAt")
        WHERE NOT "ready" AND "nextRunAt" IS NOT NULL`,
    );
    // Задачі тенанта в черзі за часом: найраніша готова (захоплення) і мінімум (облік).
    await queryRunner.query(
      `CREATE INDEX "IDX_jobs_tenant_queue" ON "jobs" ("tenantId", "runAt") WHERE "status" = 'queued'`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_jobs_claim"`);

    // Наявні тенанти: облік з фактичних задач; усі стають у черговість від моменту міграції.
    await queryRunner.query(`
      INSERT INTO tenant_usage ("tenantId", queued, running, "nextRunAt", ready, "maxRunning",
                                "maxQueueSize", "lastClaimedAt")
      SELECT t.id, COALESCE(a.queued, 0), COALESCE(a.running, 0), a.next,
             COALESCE(a.next <= now(), false), ${d.maxRunning}, ${d.maxQueueSize}, now()
        FROM tenants t
        LEFT JOIN (SELECT "tenantId",
                          count(*) FILTER (WHERE status = 'queued')::int AS queued,
                          count(*) FILTER (WHERE status = 'running')::int AS running,
                          min("runAt") FILTER (WHERE status = 'queued') AS next
                     FROM jobs GROUP BY "tenantId") a ON a."tenantId" = t.id`);

    await queryRunner.query(
      `ALTER TABLE "tenant_usage" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "tenant_usage" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `CREATE POLICY tenant_isolation ON "tenant_usage"
         USING ("tenantId" = public.app_current_tenant())
         WITH CHECK ("tenantId" = public.app_current_tenant())`,
    );
    // Runtime-ролі прав на облік і значення за замовчуванням не мають: лише тригери й функції.
    for (const table of ['tenant_usage', 'limit_defaults']) {
      await queryRunner.query(
        `REVOKE ALL ON "${table}" FROM PUBLIC, ${API_ROLE}, ${WORKER_ROLE}`,
      );
      await queryRunner.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON "${table}" TO ${SYSTEM_ROLE}`,
      );
    }

    for (const fn of TRIGGER_FUNCTIONS) {
      await queryRunner.query(fn.sql);
      await queryRunner.query(
        `ALTER FUNCTION public.${fn.name}() OWNER TO ${SYSTEM_ROLE}`,
      );
      await queryRunner.query(
        `REVOKE ALL ON FUNCTION public.${fn.name}() FROM PUBLIC`,
      );
    }
    // Окремі тригери для вставки, видалення й зміни стану/часу (WHEN відсікає решту оновлень).
    await queryRunner.query(
      `CREATE TRIGGER tenant_usage_job_insert AFTER INSERT ON "jobs"
         FOR EACH ROW EXECUTE FUNCTION public.tenant_usage_on_job()`,
    );
    await queryRunner.query(
      `CREATE TRIGGER tenant_usage_job_delete AFTER DELETE ON "jobs"
         FOR EACH ROW EXECUTE FUNCTION public.tenant_usage_on_job()`,
    );
    await queryRunner.query(
      `CREATE TRIGGER tenant_usage_job_update AFTER UPDATE OF "status", "runAt", "tenantId" ON "jobs"
         FOR EACH ROW
         WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD."runAt" IS DISTINCT FROM NEW."runAt"
               OR OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
         EXECUTE FUNCTION public.tenant_usage_on_job()`,
    );
    await queryRunner.query(
      `CREATE TRIGGER tenant_usage_tenant_insert AFTER INSERT ON "tenants"
         FOR EACH ROW EXECUTE FUNCTION public.tenant_usage_on_tenant()`,
    );
    await queryRunner.query(
      `CREATE TRIGGER tenant_usage_tenant_limits
         AFTER UPDATE OF "maxConcurrentExecutions", "maxQueueSize" ON "tenants"
         FOR EACH ROW EXECUTE FUNCTION public.tenant_usage_on_tenant()`,
    );
    await queryRunner.query(
      `CREATE TRIGGER tenant_usage_defaults AFTER UPDATE ON "limit_defaults"
         FOR EACH ROW EXECUTE FUNCTION public.tenant_usage_on_defaults()`,
    );

    for (const fn of FUNCTIONS) {
      await queryRunner.query(fn.sql);
      await queryRunner.query(
        `ALTER FUNCTION public.${fn.signature} OWNER TO ${SYSTEM_ROLE}`,
      );
      await queryRunner.query(
        `REVOKE ALL ON FUNCTION public.${fn.signature} FROM PUBLIC`,
      );
      await queryRunner.query(
        `GRANT EXECUTE ON FUNCTION public.${fn.signature} TO ${fn.grantees.join(', ')}`,
      );
    }

    // Захоплення FIFO замінює справедливе (claim_candidate + lock_tenant_usage).
    await queryRunner.query(`DROP FUNCTION public.claim_fifo_candidate()`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION public.claim_fifo_candidate()
      RETURNS TABLE (id uuid, "tenantId" uuid)
      LANGUAGE sql VOLATILE ${DEFINER} AS $$
        SELECT j.id, j."tenantId" FROM public.jobs j
         WHERE j.status = 'queued' AND j."runAt" <= pg_catalog.now()
         ORDER BY j."runAt"
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      $$`);
    await queryRunner.query(
      `ALTER FUNCTION public.claim_fifo_candidate() OWNER TO ${SYSTEM_ROLE}`,
    );
    await queryRunner.query(
      `REVOKE ALL ON FUNCTION public.claim_fifo_candidate() FROM PUBLIC`,
    );
    await queryRunner.query(
      `GRANT EXECUTE ON FUNCTION public.claim_fifo_candidate() TO ${WORKER_ROLE}`,
    );
    for (const fn of [...FUNCTIONS].reverse())
      await queryRunner.query(`DROP FUNCTION public.${fn.signature}`);
    await queryRunner.query(
      `DROP TRIGGER tenant_usage_defaults ON "limit_defaults"`,
    );
    await queryRunner.query(
      `DROP TRIGGER tenant_usage_tenant_limits ON "tenants"`,
    );
    await queryRunner.query(
      `DROP TRIGGER tenant_usage_tenant_insert ON "tenants"`,
    );
    await queryRunner.query(`DROP TRIGGER tenant_usage_job_update ON "jobs"`);
    await queryRunner.query(`DROP TRIGGER tenant_usage_job_delete ON "jobs"`);
    await queryRunner.query(`DROP TRIGGER tenant_usage_job_insert ON "jobs"`);
    for (const fn of [...TRIGGER_FUNCTIONS].reverse())
      await queryRunner.query(`DROP FUNCTION public.${fn.name}()`);
    await queryRunner.query(
      `CREATE INDEX "IDX_jobs_claim" ON "jobs" ("runAt") WHERE "status" = 'queued'`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_jobs_tenant_queue"`);
    await queryRunner.query(`DROP TABLE "tenant_usage"`);
    await queryRunner.query(`ALTER TABLE "tenants"
      DROP COLUMN "maxConcurrentExecutions", DROP COLUMN "maxQueueSize",
      DROP COLUMN "rateLimit", DROP COLUMN "webhookRateLimit"`);
    await queryRunner.query(`DROP TABLE "limit_defaults"`);
  }
}
