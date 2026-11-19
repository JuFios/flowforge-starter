import { MigrationInterface, QueryRunner } from 'typeorm';
import { RATE_KEY_MAX_LENGTH } from '../../tenancy/limits';
import { API_ROLE, SYSTEM_ROLE, WORKER_ROLE } from '../../tenancy/roles';

/** Спільні атрибути SECURITY DEFINER-функцій: pg_temp — явно останнім (документація Postgres). */
const DEFINER = `SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp`;

export function purgeRateLimitsSql(bounded: boolean): string {
  return `CREATE FUNCTION public.purge_rate_limits(p_batch integer) RETURNS integer
        LANGUAGE plpgsql VOLATILE ${DEFINER} AS $$
        DECLARE deleted integer;
        BEGIN
          DELETE FROM public.rate_limit_buckets b
           WHERE b.key = ANY (ARRAY(
                   SELECT o.key FROM public.rate_limit_buckets o
                    WHERE o."resetAt" < ${bounded ? 'pg_catalog.statement_timestamp()' : 'pg_catalog.clock_timestamp()'}
                    ORDER BY o."resetAt"
                    LIMIT LEAST(GREATEST(p_batch, 1), 10000)
                    FOR UPDATE SKIP LOCKED));
          GET DIAGNOSTICS deleted = ROW_COUNT;
          RETURN deleted;
        END $$`;
}

/**
 * Лічильник фіксованого вікна. Ревізія 1 — початкова: момент береться на вході у функцію, тобто до
 * очікування блокування рядка відра. Ревізія 2 (міграція RateLimitLockTime) бере час уже після
 * блокування: інакше запит, що чекав на рядок довше за залишок вікна, рахувався б у старому вікні й
 * отримував 429 з додатним Retry-After, хоча нове вікно вже почалося.
 */
export function rateLimitHitSql(revision: 1 | 2 | 3): string {
  if (revision === 1)
    return `CREATE FUNCTION public.rate_limit_hit(p_key text, p_window_ms integer, p_cost integer)
        RETURNS TABLE (hits integer, "resetMs" integer)
        LANGUAGE plpgsql VOLATILE ${DEFINER} AS $$
        DECLARE now_ timestamptz := pg_catalog.clock_timestamp();
        BEGIN
          IF p_key IS NULL OR pg_catalog.length(p_key) NOT BETWEEN 1 AND ${RATE_KEY_MAX_LENGTH}
             OR p_window_ms IS NULL OR p_window_ms NOT BETWEEN 1 AND 86400000
             OR p_cost IS NULL OR p_cost NOT IN (0, 1) THEN
            RAISE EXCEPTION 'invalid rate limit arguments';
          END IF;
          IF p_cost = 0 THEN
            RETURN QUERY
              SELECT CASE WHEN b."resetAt" > now_ THEN b.hits ELSE 0 END,
                     CASE WHEN b."resetAt" > now_
                          THEN pg_catalog.ceil(EXTRACT(EPOCH FROM b."resetAt" - now_) * 1000)::integer
                          ELSE 0 END
                FROM public.rate_limit_buckets b WHERE b.key = p_key;
            IF NOT FOUND THEN RETURN QUERY SELECT 0, 0; END IF;
            RETURN;
          END IF;
          RETURN QUERY
            INSERT INTO public.rate_limit_buckets AS b (key, hits, "resetAt")
            VALUES (p_key, 1, now_ + pg_catalog.make_interval(secs => p_window_ms / 1000.0))
            ON CONFLICT (key) DO UPDATE
               SET hits = CASE WHEN b."resetAt" <= now_ THEN 1 ELSE b.hits + 1 END,
                   "resetAt" = CASE WHEN b."resetAt" <= now_
                                    THEN now_ + pg_catalog.make_interval(secs => p_window_ms / 1000.0)
                                    ELSE b."resetAt" END
            RETURNING b.hits,
                      pg_catalog.ceil(EXTRACT(EPOCH FROM b."resetAt" - now_) * 1000)::integer;
        END $$`;
  const window = 'pg_catalog.make_interval(secs => p_window_ms / 1000.0)';
  const writeHit =
    revision === 2
      ? `          -- Вирази DO UPDATE обчислюються вже під блокуванням рядка (і після очікування конкурентної
          -- вставки того самого ключа), тож межа вікна перевіряється за моментом після блокування.
          RETURN QUERY
            INSERT INTO public.rate_limit_buckets AS b (key, hits, "resetAt")
            VALUES (p_key, 1, pg_catalog.clock_timestamp() + ${window})
            ON CONFLICT (key) DO UPDATE
               SET (hits, "resetAt") = (
                     SELECT CASE WHEN b."resetAt" <= c.t THEN 1 ELSE b.hits + 1 END,
                            CASE WHEN b."resetAt" <= c.t THEN c.t + ${window} ELSE b."resetAt" END
                       FROM (SELECT pg_catalog.clock_timestamp() AS t) c)
            RETURNING b.hits,
                      GREATEST(pg_catalog.ceil(EXTRACT(EPOCH FROM
                        b."resetAt" - pg_catalog.clock_timestamp()) * 1000), 0)::integer;`
      : `
          -- Серіалізуємо створення й оновлення відра до вибору початку вікна.
          LOOP
            PERFORM 1 FROM public.rate_limit_buckets b WHERE b.key = p_key FOR UPDATE;
            EXIT WHEN FOUND;
            INSERT INTO public.rate_limit_buckets (key, hits, "resetAt")
              VALUES (p_key, 0, '-infinity') ON CONFLICT (key) DO NOTHING;
            EXIT WHEN FOUND;
          END LOOP;
          now_ := pg_catalog.clock_timestamp();
          RETURN QUERY UPDATE public.rate_limit_buckets b
             SET hits = CASE WHEN b."resetAt" <= now_ THEN 1 ELSE b.hits + 1 END,
                 "resetAt" = CASE WHEN b."resetAt" <= now_ THEN now_ + ${window} ELSE b."resetAt" END
           WHERE b.key = p_key
           RETURNING b.hits, pg_catalog.ceil(EXTRACT(EPOCH FROM b."resetAt" - now_) * 1000)::integer;`;
  return `CREATE OR REPLACE FUNCTION public.rate_limit_hit(p_key text, p_window_ms integer, p_cost integer)
        RETURNS TABLE (hits integer, "resetMs" integer)
        LANGUAGE plpgsql VOLATILE ${DEFINER} AS $$
        DECLARE now_ timestamptz := pg_catalog.clock_timestamp();
        BEGIN
          IF p_key IS NULL OR pg_catalog.length(p_key) NOT BETWEEN 1 AND ${RATE_KEY_MAX_LENGTH}
             OR p_window_ms IS NULL OR p_window_ms NOT BETWEEN 1 AND 86400000
             OR p_cost IS NULL OR p_cost NOT IN (0, 1) THEN
            RAISE EXCEPTION 'invalid rate limit arguments';
          END IF;
          IF p_cost = 0 THEN
            -- Лише читання, без блокування: момент входу точний.
            RETURN QUERY
              SELECT CASE WHEN b."resetAt" > now_ THEN b.hits ELSE 0 END,
                     CASE WHEN b."resetAt" > now_
                          THEN pg_catalog.ceil(EXTRACT(EPOCH FROM b."resetAt" - now_) * 1000)::integer
                          ELSE 0 END
                FROM public.rate_limit_buckets b WHERE b.key = p_key;
            IF NOT FOUND THEN RETURN QUERY SELECT 0, 0; END IF;
            RETURN;
          END IF;
${writeHit}
        END $$`;
}

const FUNCTIONS: Array<{ signature: string; grantees: string[]; sql: string }> =
  [
    {
      // Ефективні ліміти тенанта з контексту: перевизначення тенанта або значення за
      // замовчуванням (limit_defaults недоступна runtime-ролям). Без контексту — помилка.
      signature: 'tenant_limits()',
      grantees: [API_ROLE],
      sql: `CREATE FUNCTION public.tenant_limits()
        RETURNS TABLE ("maxRunning" integer, "maxQueueSize" integer, "rateLimit" integer,
                       "rateWindowMs" integer, "webhookRateLimit" integer,
                       "webhookRateWindowMs" integer)
        LANGUAGE plpgsql STABLE ${DEFINER} AS $$
        DECLARE t uuid := public.app_current_tenant();
        BEGIN
          IF t IS NULL THEN RAISE EXCEPTION 'tenant context is required'; END IF;
          RETURN QUERY
            SELECT COALESCE(tn."maxConcurrentExecutions", d."maxRunning"),
                   COALESCE(tn."maxQueueSize", d."maxQueueSize"),
                   COALESCE(tn."rateLimit", d."rateLimit"), d."rateWindowMs",
                   COALESCE(tn."webhookRateLimit", d."webhookRateLimit"), d."webhookRateWindowMs"
              FROM public.tenants tn CROSS JOIN public.limit_defaults d
             WHERE tn.id = t;
        END $$`,
    },
    {
      // Один запит у фіксованому вікні ключа (throttler): атомарний upsert за годинником БД —
      // спільний лічильник для всіх інстансів API. p_cost = 0 — лише прочитати стан, нічого не
      // створюючи. Повертає кількість запитів у вікні й мілісекунди до його кінця.
      signature: 'rate_limit_hit(text,integer,integer)',
      grantees: [API_ROLE],
      sql: rateLimitHitSql(1),
    },
    {
      // Очищення відер, чиє вікно скінчилось (пачкою; SKIP LOCKED — інстанси не чекають одне на одне).
      signature: 'purge_rate_limits(integer)',
      grantees: [API_ROLE],
      sql: purgeRateLimitsSql(false),
    },
  ];

/**
 * Ліміти частоти запитів (ТЗ 3.3.4): відра фіксованого вікна для throttler-а в Postgres (спільні
 * для всіх інстансів API, без Redis) і ефективні ліміти тенанта для API.
 */
export class TenantLimits1795300000000 implements MigrationInterface {
  name = 'TenantLimits1795300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Звичайна (logged) таблиця: UNLOGGED обнулялася б після падіння сервера й не реплікується.
    // fillfactor 70 — місце для HOT-оновлень лічильників на тій самій сторінці.
    await queryRunner.query(`
      CREATE TABLE "rate_limit_buckets" (
        "key" text PRIMARY KEY CHECK (length("key") BETWEEN 1 AND ${RATE_KEY_MAX_LENGTH}),
        "hits" integer NOT NULL CHECK ("hits" >= 0),
        "resetAt" timestamptz NOT NULL
      ) WITH (fillfactor = 70)`);
    await queryRunner.query(
      `CREATE INDEX "IDX_rate_limit_buckets_reset" ON "rate_limit_buckets" ("resetAt")`,
    );
    // Доступ лише через функції: runtime-ролі прав на таблицю не мають.
    await queryRunner.query(
      `REVOKE ALL ON "rate_limit_buckets" FROM PUBLIC, ${API_ROLE}, ${WORKER_ROLE}`,
    );
    await queryRunner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON "rate_limit_buckets" TO ${SYSTEM_ROLE}`,
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
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const fn of [...FUNCTIONS].reverse())
      await queryRunner.query(`DROP FUNCTION public.${fn.signature}`);
    await queryRunner.query(`DROP TABLE "rate_limit_buckets"`);
  }
}
