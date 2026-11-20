import { MigrationInterface, QueryRunner } from 'typeorm';
import { API_ROLE, SYSTEM_ROLE } from '../../tenancy/roles';

const tables = ['browser_sessions', 'realtime_tickets'];

export class BrowserSessions1796700000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE public.browser_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "tenantId" uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
      "tokenHash" bytea UNIQUE NOT NULL CHECK(octet_length("tokenHash")=32),
      "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(), "expiresAt" timestamptz NOT NULL,
      UNIQUE(id,"tenantId"))`);
    await runner.query(`CREATE TABLE public.realtime_tickets (
      "tokenHash" bytea PRIMARY KEY CHECK(octet_length("tokenHash")=32), "tenantId" uuid NOT NULL,
      "executionId" uuid NOT NULL, "sessionId" uuid, "expiresAt" timestamptz NOT NULL,
      FOREIGN KEY("executionId","tenantId") REFERENCES public.executions(id,"tenantId") ON DELETE CASCADE,
      FOREIGN KEY("sessionId","tenantId") REFERENCES public.browser_sessions(id,"tenantId") ON DELETE CASCADE)`);
    await runner.query(
      'CREATE INDEX "IDX_sessions_created" ON public.browser_sessions ("tenantId","createdAt",id)',
    );
    await runner.query(
      'CREATE INDEX "IDX_tickets_expiry" ON public.realtime_tickets ("tenantId","expiresAt")',
    );
    for (const table of tables) {
      await runner.query(
        `ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`,
      );
      await runner.query(
        `ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`,
      );
      await runner.query(
        `CREATE POLICY tenant_isolation ON public.${table} USING ("tenantId" = public.app_current_tenant()) WITH CHECK ("tenantId" = public.app_current_tenant())`,
      );
      await runner.query(
        `GRANT SELECT,INSERT,DELETE ON public.${table} TO ${API_ROLE}`,
      );
      await runner.query(
        `GRANT SELECT,UPDATE,DELETE ON public.${table} TO ${SYSTEM_ROLE}`,
      );
    }
    await runner.query(`CREATE FUNCTION public.auth_session(h bytea)
      RETURNS TABLE(id uuid, "tenantId" uuid, "expiresAt" timestamptz)
      LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
      SELECT s.id,s."tenantId",s."expiresAt" FROM public.browser_sessions s
      WHERE s."tokenHash"=h AND s."expiresAt">clock_timestamp() $$`);
    await runner.query(`CREATE FUNCTION public.redeem_realtime_ticket(h bytea)
      RETURNS TABLE("tenantId" uuid,"executionId" uuid,"sessionId" uuid,"sessionExpiresAt" timestamptz)
      LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
      WITH used AS (DELETE FROM public.realtime_tickets WHERE "tokenHash"=h AND "expiresAt">clock_timestamp() RETURNING *)
      SELECT t."tenantId",t."executionId",t."sessionId",s."expiresAt" FROM used t
      LEFT JOIN public.browser_sessions s ON s.id=t."sessionId" AND s."tenantId"=t."tenantId"
      WHERE t."sessionId" IS NULL OR s."expiresAt">clock_timestamp() $$`);
    for (const table of tables)
      await runner.query(
        `CREATE INDEX "IDX_expire_${table}" ON public.${table} ("expiresAt")`,
      );
    await runner.query(`CREATE FUNCTION public.purge_browser_credentials(n integer) RETURNS integer
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
      DECLARE total integer := 0; affected integer;
      BEGIN
      ${tables
        .slice()
        .reverse()
        .map(
          (table) => `DELETE FROM public.${table} WHERE ctid IN (
        SELECT ctid FROM public.${table} WHERE "expiresAt" <= statement_timestamp() ORDER BY "expiresAt"
        LIMIT greatest(1,least(n,1000)) FOR UPDATE SKIP LOCKED);
        GET DIAGNOSTICS affected = ROW_COUNT; total := total + affected;`,
        )
        .join('\n')}
      RETURN total; END $$`);
    for (const fn of [
      'purge_browser_credentials(integer)',
      'auth_session(bytea)',
      'redeem_realtime_ticket(bytea)',
    ]) {
      await runner.query(`ALTER FUNCTION public.${fn} OWNER TO ${SYSTEM_ROLE}`);
      await runner.query(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC`);
      await runner.query(
        `GRANT EXECUTE ON FUNCTION public.${fn} TO ${API_ROLE}`,
      );
    }
    await runner.query(`CREATE FUNCTION public.notify_session_revoked() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
      BEGIN PERFORM pg_notify('ff_session_revoked',OLD.id::text); RETURN OLD; END $$`);
    await runner.query(
      'REVOKE ALL ON FUNCTION public.notify_session_revoked() FROM PUBLIC',
    );
    await runner.query(
      `CREATE TRIGGER notify_session_revoked AFTER DELETE ON public.browser_sessions FOR EACH ROW EXECUTE FUNCTION public.notify_session_revoked()`,
    );
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query(
      'DROP FUNCTION public.redeem_realtime_ticket(bytea), public.auth_session(bytea), public.purge_browser_credentials(integer)',
    );
    await runner.query(
      'DROP TABLE public.realtime_tickets, public.browser_sessions',
    );
    await runner.query('DROP FUNCTION public.notify_session_revoked()');
  }
}
