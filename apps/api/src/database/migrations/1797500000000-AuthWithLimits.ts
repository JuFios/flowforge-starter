import { MigrationInterface, QueryRunner } from 'typeorm';
import { API_ROLE, SYSTEM_ROLE } from '../../tenancy/roles';

const DEFINER = `SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp`;

/**
 * Ефективні ліміти тенанта `tn` — той самий вираз, що в `tenant_limits()` (міграція OutboxQuota).
 * Рівність результатів перевіряє `auth-statements.int-spec.ts`: зміна одного без другого — червоний
 * тест.
 */
const LIMIT_COLUMNS = `COALESCE(tn."maxConcurrentExecutions", d."maxRunning") AS "maxRunning",
         COALESCE(tn."maxQueueSize", d."maxQueueSize") AS "maxQueueSize",
         COALESCE(tn."rateLimit", d."rateLimit") AS "rateLimit", d."rateWindowMs",
         COALESCE(tn."webhookRateLimit", d."webhookRateLimit") AS "webhookRateLimit", d."webhookRateWindowMs",
         COALESCE(tn."maxWorkflows", d."maxWorkflows") AS "maxWorkflows",
         COALESCE(tn."maxOutboxEvents", d."maxOutboxEvents") AS "maxOutboxEvents"`;

const LIMIT_TYPES = `"maxRunning" integer, "maxQueueSize" integer, "rateLimit" integer,
                   "rateWindowMs" integer, "webhookRateLimit" integer, "webhookRateWindowMs" integer,
                   "maxWorkflows" integer, "maxOutboxEvents" integer`;

const AUTH_TENANT_V1 = `CREATE FUNCTION public.auth_tenant(p_api_key_hash text) RETURNS uuid
      LANGUAGE sql STABLE ${DEFINER} AS $$
        SELECT t.id FROM public.tenants t
         WHERE p_api_key_hash IS NOT NULL AND pg_catalog.length(p_api_key_hash) = 64
           AND t."apiKeyHash" = p_api_key_hash
      $$`;

const AUTH_SESSION_V1 = `CREATE FUNCTION public.auth_session(h bytea)
      RETURNS TABLE(id uuid, "tenantId" uuid, "expiresAt" timestamptz)
      LANGUAGE sql VOLATILE ${DEFINER} AS $$
      SELECT s.id,s."tenantId",s."expiresAt" FROM public.browser_sessions s
      WHERE s."tokenHash"=h AND s."expiresAt">clock_timestamp() $$`;

/**
 * Автентифікація разом з ефективними лімітами (docs/architecture.md, «Автентифікація запиту»):
 * один виклик замість пошуку ключа й окремої транзакції тенанта з `tenant_limits()`. Функції
 * повертають лише ідентифікатори, строк сесії й числа меж тенанта, чиїм ключем чи сесією доведено
 * володіння, — жодних секретів (тест `rls`, «return only identifiers and numbers»). Сигнатури ті
 * самі, тож переліки прав (`security-posture`, `login-role-check`) не змінюються.
 */
export class AuthWithLimits1797500000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query('DROP FUNCTION public.auth_tenant(text)');
    await runner.query(`CREATE FUNCTION public.auth_tenant(p_api_key_hash text)
      RETURNS TABLE (id uuid, ${LIMIT_TYPES})
      LANGUAGE sql STABLE ${DEFINER} AS $$
        SELECT tn.id, ${LIMIT_COLUMNS}
          FROM public.tenants tn CROSS JOIN public.limit_defaults d
         WHERE p_api_key_hash IS NOT NULL AND pg_catalog.length(p_api_key_hash) = 64
           AND tn."apiKeyHash" = p_api_key_hash
      $$`);
    await runner.query('DROP FUNCTION public.auth_session(bytea)');
    await runner.query(`CREATE FUNCTION public.auth_session(h bytea)
      RETURNS TABLE (id uuid, "tenantId" uuid, "expiresAt" timestamptz, ${LIMIT_TYPES})
      LANGUAGE sql VOLATILE ${DEFINER} AS $$
        SELECT s.id, s."tenantId", s."expiresAt", ${LIMIT_COLUMNS}
          FROM public.browser_sessions s
          JOIN public.tenants tn ON tn.id = s."tenantId"
          CROSS JOIN public.limit_defaults d
         WHERE s."tokenHash" = h AND s."expiresAt" > pg_catalog.clock_timestamp()
      $$`);
    for (const fn of ['auth_tenant(text)', 'auth_session(bytea)'])
      await own(runner, fn);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP FUNCTION public.auth_tenant(text)');
    await runner.query(AUTH_TENANT_V1);
    await runner.query('DROP FUNCTION public.auth_session(bytea)');
    await runner.query(AUTH_SESSION_V1);
    for (const fn of ['auth_tenant(text)', 'auth_session(bytea)'])
      await own(runner, fn);
  }
}

async function own(runner: QueryRunner, signature: string): Promise<void> {
  await runner.query(
    `ALTER FUNCTION public.${signature} OWNER TO ${SYSTEM_ROLE}`,
  );
  await runner.query(`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC`);
  await runner.query(
    `GRANT EXECUTE ON FUNCTION public.${signature} TO ${API_ROLE}`,
  );
}
