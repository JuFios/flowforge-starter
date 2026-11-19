import { MigrationInterface, QueryRunner } from 'typeorm';
import { API_ROLE, SYSTEM_ROLE, WORKER_ROLE } from '../../tenancy/roles';

const DEFINER = `SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp`;

/** Момент у форматі ISO 8601 UTC з мілісекундами (як Date#toISOString). */
const ISO = (expr: string) =>
  `to_char(${expr} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const TENANT_TABLES = [
  'notification_settings',
  'outbox_events',
  'outbox_attempts',
] as const;

/**
 * Вихідні події через транзакційний outbox (README 3.3.9).
 *
 * - `notification_settings` — endpoint і ключі підпису тенанта (поточний і наступний, як у
 *   вхідних webhook-ів), `dueAt` — найраніший момент, коли в тенанта є що надсилати.
 * - `outbox_events` — логічна подія: стабільний ID, незмінні байти payload, стан доставки.
 * - `outbox_attempts` — журнал спроб для оператора.
 *
 * Подію пише тригер на `executions` у транзакції, що переводить виконання в кінцевий стан, тож
 * подія й завершення фіксуються разом на будь-якому шляху (воркер, reaper, провал).
 * `terminalCycles` нумерує цикли виконання: ручний `/retry` відкриває новий цикл, і його завершення
 * — нова подія з наступним `sequence`. Завершення до цієї міграції подій не створюють.
 */
export class NotificationOutbox1796200000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(
      `ALTER TABLE public.executions ADD "terminalCycles" integer NOT NULL DEFAULT 0`,
    );
    // Цикл, що вже завершився до оновлення, — перший: /retry після оновлення дає sequence 2.
    await runner.query(
      `UPDATE public.executions SET "terminalCycles" = 1 WHERE status IN ('succeeded', 'failed')`,
    );
    await runner.query(`CREATE TABLE public.notification_settings (
      "tenantId" uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE NO ACTION,
      url text NOT NULL CHECK (char_length(url) BETWEEN 1 AND 2048),
      enabled boolean NOT NULL DEFAULT true,
      revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
      "secretKeyId" uuid NOT NULL DEFAULT gen_random_uuid(),
      secret varchar NOT NULL CHECK (char_length(secret) >= 32),
      "nextSecretKeyId" uuid,
      "nextSecret" varchar CHECK (char_length("nextSecret") >= 32),
      "dueAt" timestamptz,
      "lastClaimedAt" timestamptz,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "CHK_notification_key_pair" CHECK (
        ("nextSecretKeyId" IS NULL) = ("nextSecret" IS NULL)
        AND "secretKeyId" IS DISTINCT FROM "nextSecretKeyId")
    )`);
    await runner.query(`CREATE TABLE public.outbox_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "tenantId" uuid NOT NULL REFERENCES public.tenants(id) ON DELETE NO ACTION,
      "executionId" uuid NOT NULL,
      sequence integer NOT NULL CHECK (sequence > 0),
      type varchar(64) NOT NULL,
      payload text NOT NULL,
      "correlationId" varchar(128),
      status varchar(16) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'sending', 'delivered', 'cancelled')),
      attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      "nextAttemptAt" timestamptz NOT NULL DEFAULT now(),
      "leaseToken" uuid,
      "leaseUntil" timestamptz,
      "lastError" varchar(64),
      "lastStatus" integer,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "deliveredAt" timestamptz,
      CONSTRAINT "UQ_outbox_events_cycle" UNIQUE ("tenantId", "executionId", sequence),
      CONSTRAINT "UQ_outbox_events_id_tenant" UNIQUE (id, "tenantId"),
      CONSTRAINT "CHK_outbox_events_lease" CHECK (
        (status = 'sending') = ("leaseToken" IS NOT NULL AND "leaseUntil" IS NOT NULL))
    )`);
    await runner.query(`CREATE TABLE public.outbox_attempts (
      "eventId" uuid NOT NULL,
      "tenantId" uuid NOT NULL,
      attempt integer NOT NULL CHECK (attempt > 0),
      "senderId" varchar(64) NOT NULL,
      revision integer,
      "keyIds" uuid[],
      "startedAt" timestamptz NOT NULL DEFAULT now(),
      "finishedAt" timestamptz,
      outcome varchar(32),
      "httpStatus" integer,
      "durationMs" integer,
      PRIMARY KEY ("eventId", attempt),
      CONSTRAINT "FK_outbox_attempts_event" FOREIGN KEY ("eventId", "tenantId")
        REFERENCES public.outbox_events(id, "tenantId") ON DELETE CASCADE
    )`);
    // Вибір належної події тенанта, повернення прострочених спроб, очищення доставлених.
    await runner.query(
      `CREATE INDEX "IDX_outbox_events_pending" ON public.outbox_events ("tenantId", "nextAttemptAt") WHERE status = 'pending'`,
    );
    await runner.query(
      `CREATE INDEX "IDX_outbox_events_sending" ON public.outbox_events ("tenantId", "leaseUntil") WHERE status = 'sending'`,
    );
    await runner.query(
      `CREATE INDEX "IDX_outbox_events_delivered" ON public.outbox_events ("deliveredAt") WHERE status = 'delivered'`,
    );
    await runner.query(
      `CREATE INDEX "IDX_outbox_events_tenant_created" ON public.outbox_events ("tenantId", "createdAt", id)`,
    );
    await runner.query(
      `CREATE INDEX "IDX_notification_settings_due" ON public.notification_settings ("dueAt") WHERE enabled`,
    );
    for (const table of TENANT_TABLES) {
      await runner.query(
        `ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`,
      );
      await runner.query(
        `ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`,
      );
      await runner.query(
        `CREATE POLICY tenant_isolation ON public.${table} USING ("tenantId" = public.app_current_tenant()) WITH CHECK ("tenantId" = public.app_current_tenant())`,
      );
    }
    // API: налаштування тенанта, перегляд подій, повторна доставка й скасування.
    await runner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON public.notification_settings TO ${API_ROLE}`,
    );
    await runner.query(
      `GRANT SELECT, UPDATE ON public.outbox_events TO ${API_ROLE}`,
    );
    await runner.query(`GRANT SELECT ON public.outbox_attempts TO ${API_ROLE}`);
    // Воркер (відправник): читає налаштування тенанта події, записує результат спроби.
    await runner.query(
      `GRANT SELECT ON public.notification_settings TO ${WORKER_ROLE}`,
    );
    await runner.query(
      `GRANT SELECT, UPDATE ON public.outbox_events TO ${WORKER_ROLE}`,
    );
    await runner.query(
      `GRANT SELECT, UPDATE ON public.outbox_attempts TO ${WORKER_ROLE}`,
    );
    for (const table of TENANT_TABLES)
      await runner.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON public.${table} TO ${SYSTEM_ROLE}`,
      );

    // Номер циклу: перехід у кінцевий стан із некінцевого.
    await runner.query(`CREATE FUNCTION public.execution_terminal_cycle() RETURNS trigger
      LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
      BEGIN
        IF NEW.status IN ('succeeded', 'failed') AND OLD.status NOT IN ('succeeded', 'failed') THEN
          NEW."terminalCycles" := OLD."terminalCycles" + 1;
        END IF;
        RETURN NEW;
      END $$`);
    // Подія циклу — у транзакції переходу. Payload серіалізується один раз і далі не змінюється.
    await runner.query(`CREATE FUNCTION public.outbox_on_execution() RETURNS trigger
      LANGUAGE plpgsql ${DEFINER} AS $$
      DECLARE
        event_id uuid := gen_random_uuid();
        corr varchar(128);
        wf_version integer;
      BEGIN
        IF NEW."terminalCycles" <= OLD."terminalCycles" THEN
          RETURN NULL;
        END IF;
        PERFORM 1 FROM public.notification_settings s
          WHERE s."tenantId" = NEW."tenantId" AND s.enabled;
        IF NOT FOUND THEN
          RETURN NULL;
        END IF;
        SELECT j."correlationId" INTO corr FROM public.jobs j
          WHERE j."executionId" = NEW.id AND j."tenantId" = NEW."tenantId"
          ORDER BY j."createdAt" DESC LIMIT 1;
        SELECT v.version INTO wf_version FROM public.workflow_versions v
          WHERE v.id = NEW."workflowVersionId" AND v."tenantId" = NEW."tenantId";
        INSERT INTO public.outbox_events
          (id, "tenantId", "executionId", sequence, type, payload, "correlationId")
        VALUES (
          event_id, NEW."tenantId", NEW.id, NEW."terminalCycles", 'execution.' || NEW.status,
          jsonb_build_object(
            'specVersion', 1,
            'id', event_id,
            'type', 'execution.' || NEW.status,
            'createdAt', ${ISO('now()')},
            'tenantId', NEW."tenantId",
            'correlationId', COALESCE(corr, NEW."correlationId"),
            'data', jsonb_build_object(
              'executionId', NEW.id,
              'sequence', NEW."terminalCycles",
              'workflowId', NEW."workflowId",
              'workflowVersion', wf_version,
              'status', NEW.status,
              'trigger', NEW.trigger,
              'scheduledAt', ${ISO('NEW."scheduledAt"')},
              'finishedAt', ${ISO('COALESCE(NEW."finishedAt", now())')},
              'error', left(NEW.error, 1000)
            )
          )::text,
          COALESCE(corr, NEW."correlationId")
        );
        -- Рядок налаштувань блокується, лише коли значення справді знижується.
        UPDATE public.notification_settings SET "dueAt" = now()
          WHERE "tenantId" = NEW."tenantId" AND ("dueAt" IS NULL OR "dueAt" > now());
        RETURN NULL;
      END $$`);
    await runner.query(`CREATE TRIGGER execution_terminal_cycle
      BEFORE UPDATE OF status ON public.executions
      FOR EACH ROW EXECUTE FUNCTION public.execution_terminal_cycle()`);
    await runner.query(`CREATE TRIGGER outbox_on_execution
      AFTER UPDATE OF status ON public.executions
      FOR EACH ROW EXECUTE FUNCTION public.outbox_on_execution()`);

    // Захоплення спроби доставки (крос-тенантне, лише ідентифікатори й fencing-токен).
    await runner.query(`CREATE FUNCTION public.claim_outbox_event(
        p_sender text, p_lease_ms integer, p_in_flight integer)
      RETURNS TABLE (id uuid, "tenantId" uuid, "leaseToken" uuid, attempt integer,
                     "correlationId" varchar, repaired integer)
      LANGUAGE plpgsql VOLATILE ${DEFINER} AS $$
      DECLARE
        s record;
        e record;
        busy integer;
        fixed integer := 0;
        lease interval := make_interval(secs => LEAST(GREATEST(p_lease_ms, 1000), 600000) / 1000.0);
      BEGIN
        FOR s IN
          -- Тенанти, що вже вичерпали ліміт спроб у роботі, у вікно кандидатів не потрапляють:
          -- інакше 16 тенантів із завислими endpoint-ами займали б усе вікно до спливання lease.
          SELECT n."tenantId" FROM public.notification_settings n
           WHERE n.enabled AND n."dueAt" <= now()
             AND (SELECT count(*) FROM public.outbox_events b
                   WHERE b."tenantId" = n."tenantId" AND b.status = 'sending'
                     AND b."leaseUntil" > now()) < GREATEST(p_in_flight, 1)
           ORDER BY n."lastClaimedAt" NULLS FIRST, n."tenantId"
           LIMIT 16
           FOR NO KEY UPDATE SKIP LOCKED
        LOOP
          SELECT count(*) INTO busy FROM public.outbox_events o
           WHERE o."tenantId" = s."tenantId" AND o.status = 'sending' AND o."leaseUntil" > now();
          CONTINUE WHEN busy >= GREATEST(p_in_flight, 1);
          -- Спроба, чий відправник зник (lease минув), — першою: вона найдовше чекає.
          SELECT o.id, o.attempts INTO e FROM public.outbox_events o
           WHERE o."tenantId" = s."tenantId" AND o.status = 'sending' AND o."leaseUntil" <= now()
           ORDER BY o."leaseUntil" LIMIT 1 FOR UPDATE SKIP LOCKED;
          IF FOUND THEN
            UPDATE public.outbox_attempts a SET outcome = 'lease_expired', "finishedAt" = now()
             WHERE a."eventId" = e.id AND a.attempt = e.attempts AND a."finishedAt" IS NULL;
          ELSE
            SELECT o.id, o.attempts INTO e FROM public.outbox_events o
             WHERE o."tenantId" = s."tenantId" AND o.status = 'pending' AND o."nextAttemptAt" <= now()
             ORDER BY o."nextAttemptAt" LIMIT 1 FOR UPDATE SKIP LOCKED;
          END IF;
          IF NOT FOUND THEN
            -- Підказка застаріла (спробу щойно записали чи подію доставили): перерахувати.
            UPDATE public.notification_settings n SET "dueAt" = LEAST(
                (SELECT min(o."nextAttemptAt") FROM public.outbox_events o
                  WHERE o."tenantId" = s."tenantId" AND o.status = 'pending'),
                (SELECT min(o."leaseUntil") FROM public.outbox_events o
                  WHERE o."tenantId" = s."tenantId" AND o.status = 'sending'))
             WHERE n."tenantId" = s."tenantId";
            fixed := fixed + 1;
            CONTINUE;
          END IF;
          UPDATE public.outbox_events o
             SET status = 'sending', "leaseToken" = gen_random_uuid(),
                 "leaseUntil" = clock_timestamp() + lease, attempts = o.attempts + 1
           WHERE o.id = e.id
           RETURNING o.id, o."tenantId", o."leaseToken", o.attempts, o."correlationId"
            INTO id, "tenantId", "leaseToken", attempt, "correlationId";
          INSERT INTO public.outbox_attempts ("eventId", "tenantId", attempt, "senderId")
          VALUES (id, "tenantId", attempt, left(p_sender, 64));
          UPDATE public.notification_settings n SET "lastClaimedAt" = clock_timestamp()
           WHERE n."tenantId" = s."tenantId";
          repaired := fixed;
          RETURN NEXT;
          RETURN;
        END LOOP;
        id := NULL; "tenantId" := NULL; "leaseToken" := NULL; attempt := NULL;
        "correlationId" := NULL; repaired := fixed;
        RETURN NEXT;
      END $$`);
    // Очищення доставлених подій (з їхніми спробами); недоставлені не видаляються ніколи.
    await runner.query(`CREATE FUNCTION public.purge_delivered_events(p_days integer, p_batch integer)
      RETURNS integer LANGUAGE sql VOLATILE ${DEFINER} AS $$
        WITH batch AS (
          SELECT o.id FROM public.outbox_events o
           WHERE o.status = 'delivered' AND o."deliveredAt" < now() - make_interval(days => p_days)
           ORDER BY o."deliveredAt"
           LIMIT LEAST(GREATEST(p_batch, 1), 10000)
           FOR UPDATE SKIP LOCKED),
        deleted AS (DELETE FROM public.outbox_events o USING batch b WHERE o.id = b.id RETURNING 1)
        SELECT count(*)::integer FROM deleted
      $$`);
    // Беклог доставки для метрик: лише кількості й вік, без даних тенантів.
    await runner.query(`CREATE FUNCTION public.outbox_backlog()
      RETURNS TABLE ("tenantId" uuid, pending integer, sending integer, oldest timestamptz)
      LANGUAGE sql STABLE ${DEFINER} AS $$
        SELECT o."tenantId",
               (count(*) FILTER (WHERE o.status = 'pending'))::integer,
               (count(*) FILTER (WHERE o.status = 'sending'))::integer,
               min(o."createdAt")
          FROM public.outbox_events o
         WHERE o.status IN ('pending', 'sending')
         GROUP BY o."tenantId"
      $$`);
    for (const [signature, grantee] of [
      ['execution_terminal_cycle()', null],
      ['outbox_on_execution()', null],
      ['claim_outbox_event(text,integer,integer)', WORKER_ROLE],
      ['purge_delivered_events(integer,integer)', WORKER_ROLE],
      ['outbox_backlog()', WORKER_ROLE],
    ] as const) {
      await runner.query(
        `ALTER FUNCTION public.${signature} OWNER TO ${SYSTEM_ROLE}`,
      );
      await runner.query(
        `REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC`,
      );
      if (grantee)
        await runner.query(
          `GRANT EXECUTE ON FUNCTION public.${signature} TO ${grantee}`,
        );
    }
  }

  async down(runner: QueryRunner): Promise<void> {
    const pending = (await runner.query(
      `SELECT 1 FROM public.outbox_events WHERE status IN ('pending', 'sending') LIMIT 1`,
    )) as unknown[];
    if (pending.length)
      throw new Error(
        'undelivered outbox events prevent a lossless downgrade: deliver or cancel them first',
      );
    await runner.query('DROP TRIGGER outbox_on_execution ON public.executions');
    await runner.query(
      'DROP TRIGGER execution_terminal_cycle ON public.executions',
    );
    await runner.query('DROP FUNCTION public.outbox_backlog()');
    await runner.query(
      'DROP FUNCTION public.purge_delivered_events(integer,integer)',
    );
    await runner.query(
      'DROP FUNCTION public.claim_outbox_event(text,integer,integer)',
    );
    await runner.query('DROP FUNCTION public.outbox_on_execution()');
    await runner.query('DROP FUNCTION public.execution_terminal_cycle()');
    await runner.query('DROP TABLE public.outbox_attempts');
    await runner.query('DROP TABLE public.outbox_events');
    await runner.query('DROP TABLE public.notification_settings');
    await runner.query(
      'ALTER TABLE public.executions DROP COLUMN "terminalCycles"',
    );
  }
}
