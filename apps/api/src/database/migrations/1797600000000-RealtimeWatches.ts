import { MigrationInterface, QueryRunner } from 'typeorm';
import { API_ROLE, SYSTEM_ROLE } from '../../tenancy/roles';

/**
 * Найбільше виконань, які один інстанс API продовжує за виклик: не менше за найбільше допустиме
 * REALTIME_MAX_CONNECTIONS (підписок не більше, ніж сокетів), інакше продовження відмовляло б і всі
 * підписки інстансу спливали б (тест `realtime-renewal-bound.spec.ts`).
 */
export const MAX_WATCHES_PER_RENEWAL = 10_000;
/** Скільки прострочених рядків прибирає один виклик продовження. */
const PURGE_BATCH = 1000;

const NOTIFY_V1 = `CREATE OR REPLACE FUNCTION public.notify_execution() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
      DECLARE row_id uuid; tenant uuid;
      BEGIN
        IF TG_OP='DELETE' THEN row_id:=OLD.id; tenant:=OLD."tenantId"; ELSE row_id:=NEW.id; tenant:=NEW."tenantId"; END IF;
        PERFORM pg_notify('ff_execution',tenant::text || ':' || row_id::text);
        RETURN NULL;
      END $$`;

/**
 * Сповіщення `ff_execution` лише для виконань, які переглядає хоч один інстанс API
 * (docs/architecture.md, «Сповіщення лише для переглянутих виконань»). Коміт із `NOTIFY` у Postgres
 * серіалізується глобальним блокуванням черги сповіщень, тож сповіщення на кожен крок кожного
 * виконання обмежувало б пропускну здатність комітів усіх воркерів, хоча більшість виконань ніхто
 * не дивиться.
 *
 * - `realtime_watches` — підписки інстансів API: рядок на (виконання, інстанс) зі строком дії. RLS
 *   тенанта; інстанс створює й видаляє рядки в контексті тенанта підписки.
 * - `notify_execution()` стає SECURITY DEFINER (власник — системна роль, BYPASSRLS): тригер бачить
 *   підписки під будь-якою роллю, що змінює виконання, а сама роль воркера прав на таблицю не має.
 * - `renew_realtime_watches(...)` — продовження підписок інстансу одним викликом: відновлює
 *   відсутні рядки (лише для наявних виконань того самого тенанта), видаляє рядки інстансу, яких
 *   уже немає в переліку, і порцію прострочених рядків будь-яких інстансів (зниклих). Повертає
 *   кількість відновлених рядків.
 */
export class RealtimeWatches1797600000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE public.realtime_watches (
      "executionId" uuid NOT NULL,
      "tenantId" uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
      "instanceId" uuid NOT NULL,
      "expiresAt" timestamptz NOT NULL,
      PRIMARY KEY ("executionId", "instanceId"))`);
    await runner.query(
      'CREATE INDEX "IDX_realtime_watches_instance" ON public.realtime_watches ("instanceId")',
    );
    await runner.query(
      'CREATE INDEX "IDX_realtime_watches_expiry" ON public.realtime_watches ("expiresAt")',
    );
    await runner.query(
      'ALTER TABLE public.realtime_watches ENABLE ROW LEVEL SECURITY',
    );
    await runner.query(
      'ALTER TABLE public.realtime_watches FORCE ROW LEVEL SECURITY',
    );
    await runner.query(
      `CREATE POLICY tenant_isolation ON public.realtime_watches USING ("tenantId" = public.app_current_tenant()) WITH CHECK ("tenantId" = public.app_current_tenant())`,
    );
    await runner.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON public.realtime_watches TO ${API_ROLE}`,
    );
    await runner.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON public.realtime_watches TO ${SYSTEM_ROLE}`,
    );

    await runner.query(`CREATE OR REPLACE FUNCTION public.notify_execution() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
      DECLARE row_id uuid; tenant uuid;
      BEGIN
        IF TG_OP = 'DELETE' THEN row_id := OLD.id; tenant := OLD."tenantId";
        ELSE row_id := NEW.id; tenant := NEW."tenantId"; END IF;
        IF EXISTS (SELECT 1 FROM public.realtime_watches w
                    WHERE w."executionId" = row_id AND w."tenantId" = tenant
                      AND w."expiresAt" > pg_catalog.clock_timestamp()) THEN
          PERFORM pg_catalog.pg_notify('ff_execution', tenant::text || ':' || row_id::text);
        END IF;
        RETURN NULL;
      END $$`);
    await runner.query(
      `ALTER FUNCTION public.notify_execution() OWNER TO ${SYSTEM_ROLE}`,
    );
    await runner.query(
      'REVOKE ALL ON FUNCTION public.notify_execution() FROM PUBLIC',
    );

    await runner.query(`CREATE FUNCTION public.renew_realtime_watches(
        p_instance uuid, p_executions uuid[], p_tenants uuid[], p_ttl_ms integer)
      RETURNS integer
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
      DECLARE restored integer;
      BEGIN
        IF p_instance IS NULL OR p_executions IS NULL OR p_tenants IS NULL
           OR pg_catalog.cardinality(p_executions) <> pg_catalog.cardinality(p_tenants)
           OR pg_catalog.cardinality(p_executions) > ${MAX_WATCHES_PER_RENEWAL}
           OR p_ttl_ms IS NULL OR p_ttl_ms < 1000 OR p_ttl_ms > 600000 THEN
          RAISE EXCEPTION 'invalid watch renewal arguments';
        END IF;
        DELETE FROM public.realtime_watches w
         WHERE w."instanceId" = p_instance AND w."executionId" <> ALL (p_executions);
        -- unnest з кількома масивами — синтаксис FROM, кваліфікувати його не можна; search_path
        -- функції ставить pg_catalog першим.
        WITH wanted AS (
          SELECT DISTINCT u.e, u.t
            FROM unnest(p_executions, p_tenants) AS u(e, t)
            JOIN public.executions x ON x.id = u.e AND x."tenantId" = u.t
        ), upserted AS (
          INSERT INTO public.realtime_watches ("executionId", "tenantId", "instanceId", "expiresAt")
          SELECT wanted.e, wanted.t, p_instance,
                 pg_catalog.clock_timestamp() + make_interval(secs => p_ttl_ms / 1000.0)
            FROM wanted
          ON CONFLICT ("executionId", "instanceId") DO UPDATE SET "expiresAt" = EXCLUDED."expiresAt"
          RETURNING (xmax = 0) AS inserted
        )
        SELECT count(*) FILTER (WHERE inserted)::integer INTO restored FROM upserted;
        DELETE FROM public.realtime_watches w WHERE w.ctid IN (
          SELECT o.ctid FROM public.realtime_watches o
           WHERE o."expiresAt" <= pg_catalog.clock_timestamp()
           ORDER BY o."expiresAt" LIMIT ${PURGE_BATCH} FOR UPDATE SKIP LOCKED);
        RETURN restored;
      END $$`);
    const renew = 'renew_realtime_watches(uuid,uuid[],uuid[],integer)';
    await runner.query(
      `ALTER FUNCTION public.${renew} OWNER TO ${SYSTEM_ROLE}`,
    );
    await runner.query(`REVOKE ALL ON FUNCTION public.${renew} FROM PUBLIC`);
    await runner.query(
      `GRANT EXECUTE ON FUNCTION public.${renew} TO ${API_ROLE}`,
    );
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(
      'DROP FUNCTION public.renew_realtime_watches(uuid,uuid[],uuid[],integer)',
    );
    await runner.query(NOTIFY_V1);
    await runner.query(
      'ALTER FUNCTION public.notify_execution() OWNER TO CURRENT_USER',
    );
    await runner.query(
      'REVOKE ALL ON FUNCTION public.notify_execution() FROM PUBLIC',
    );
    await runner.query('DROP TABLE public.realtime_watches');
  }
}
