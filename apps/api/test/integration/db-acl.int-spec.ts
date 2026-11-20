import { DataSource } from 'typeorm';
import { openTestDataSource } from '../helpers/db';

const ROLES = [
  'flowforge_api_role',
  'flowforge_worker_role',
  'flowforge_system',
];

/**
 * Права на таблиці — точна відповідність (docs/operations.md, «Операції → права»): зайве право — такий самий
 * провал, як і відсутнє. Звуження до рядків тенанта дає RLS, крос-тенантні операції — лише
 * SECURITY DEFINER-функції. Виконуваність цих прав доводить role-operations.int-spec.
 */
const TABLE_PRIVILEGES: Record<string, Record<string, string>> = {
  flowforge_api_role: {
    browser_sessions: 'DELETE,INSERT,SELECT',
    realtime_tickets: 'DELETE,INSERT,SELECT',
    executions: 'INSERT,SELECT,UPDATE',
    jobs: 'INSERT,SELECT,UPDATE',
    notification_settings: 'DELETE,INSERT,SELECT,UPDATE',
    outbox_attempts: 'SELECT',
    outbox_events: 'SELECT,UPDATE',
    step_runs: 'SELECT',
    tenants: 'INSERT,SELECT,UPDATE',
    workflow_versions: 'INSERT,SELECT',
    webhook_deliveries: 'INSERT,SELECT',
    workflows: 'DELETE,INSERT,SELECT,UPDATE',
  },
  flowforge_worker_role: {
    executions: 'SELECT,UPDATE',
    jobs: 'SELECT,UPDATE',
    notification_settings: 'SELECT',
    outbox_attempts: 'SELECT,UPDATE',
    outbox_events: 'SELECT,UPDATE',
    step_runs: 'INSERT,SELECT,UPDATE',
    workflow_versions: 'SELECT',
  },
  flowforge_system: {
    workflow_usage: 'INSERT,SELECT,UPDATE',
    browser_sessions: 'DELETE,SELECT,UPDATE',
    realtime_tickets: 'DELETE,SELECT,UPDATE',
    executions: 'DELETE,INSERT,SELECT,UPDATE',
    jobs: 'DELETE,INSERT,SELECT,UPDATE',
    limit_defaults: 'DELETE,INSERT,SELECT,UPDATE',
    notification_settings: 'DELETE,INSERT,SELECT,UPDATE',
    outbox_attempts: 'DELETE,INSERT,SELECT,UPDATE',
    outbox_events: 'DELETE,INSERT,SELECT,UPDATE',
    rate_limit_buckets: 'DELETE,INSERT,SELECT,UPDATE',
    step_runs: 'DELETE,INSERT,SELECT,UPDATE',
    tenant_usage: 'DELETE,INSERT,SELECT,UPDATE',
    tenants: 'DELETE,INSERT,SELECT,UPDATE',
    workflow_versions: 'DELETE,INSERT,SELECT,UPDATE',
    workflows: 'DELETE,INSERT,SELECT,UPDATE',
  },
};

/** Хто може виконувати функції схеми public (власник SECURITY DEFINER-функцій — системна роль). */
const FUNCTION_EXECUTE: Record<string, string[]> = {
  flowforge_api_role: [
    'app_current_tenant()',
    'auth_session(bytea)',
    'auth_tenant(text)',
    'due_schedule_tenants(uuid,integer)',
    'lock_tenant_usage()',
    'purge_browser_credentials(integer)',
    'purge_rate_limits(integer)',
    'rate_limit_hit(text,integer,integer)',
    'redeem_realtime_ticket(bytea)',
    'tenant_limits()',
    'webhook_tenant(uuid)',
  ],
  flowforge_worker_role: [
    'app_current_tenant()',
    'claim_job(text,integer)',
    'claim_outbox_event(text,integer,integer)',
    'expired_lease_tenants(uuid[],integer)',
    'finish_outbox_event(uuid,uuid,double precision,text,integer)',
    'outbox_backlog()',
    'purge_delivered_events(integer,integer)',
    'purge_execution_history(integer,integer)',
    'purge_finished_jobs(integer,integer)',
    'queue_depth_by_tenant()',
  ],
  // Власник: тіла definer-функцій і тригерні функції обліку (їх викликає лише тригер).
  flowforge_system: [
    'app_current_tenant()',
    'auth_session(bytea)',
    'auth_tenant(text)',
    'claim_job(text,integer)',
    'claim_outbox_event(text,integer,integer)',
    'close_cancelled_attempt()',
    'due_schedule_tenants(uuid,integer)',
    'execution_terminal_cycle()',
    'expired_lease_tenants(uuid[],integer)',
    'finish_outbox_event(uuid,uuid,double precision,text,integer)',
    'lock_tenant_usage()',
    'outbox_backlog()',
    'outbox_on_execution()',
    'purge_browser_credentials(integer)',
    'purge_delivered_events(integer,integer)',
    'purge_execution_history(integer,integer)',
    'purge_finished_jobs(integer,integer)',
    'purge_rate_limits(integer)',
    'queue_depth_by_tenant()',
    'rate_limit_hit(text,integer,integer)',
    'redeem_realtime_ticket(bytea)',
    'tenant_limits()',
    'tenant_usage_on_defaults()',
    'tenant_usage_on_job()',
    'tenant_usage_on_tenant()',
    'webhook_tenant(uuid)',
    'workflow_quota()',
  ],
};

describe('database privileges match the operations matrix exactly', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = await openTestDataSource();
  });

  afterAll(async () => {
    await ds.destroy();
  });

  it('grants each role exactly the table privileges its operations need', async () => {
    const rows: Array<{ role: string; table: string; privileges: string }> =
      await ds.query(
        `SELECT r.role, c.relname AS table,
                string_agg(p.priv, ',' ORDER BY p.priv) AS privileges
           FROM pg_class c
           CROSS JOIN unnest($1::text[]) AS r(role)
           CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE',
                                   'REFERENCES', 'TRIGGER']) AS p(priv)
          WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm')
            AND has_table_privilege(r.role, c.oid, p.priv)
          GROUP BY r.role, c.relname`,
        [ROLES],
      );
    const actual: Record<string, Record<string, string>> = {};
    for (const { role, table, privileges } of rows)
      (actual[role] ??= {})[table] = privileges;
    expect(actual).toEqual(TABLE_PRIVILEGES);
  });

  it('grants no column-level privileges and nothing to PUBLIC on tables', async () => {
    expect(
      await ds.query(
        `SELECT c.relname, a.attname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
          WHERE c.relnamespace = 'public'::regnamespace AND a.attacl IS NOT NULL`,
      ),
    ).toEqual([]);
    expect(
      await ds.query(
        `SELECT c.relname, acl.privilege_type FROM pg_class c, aclexplode(c.relacl) acl
          WHERE c.relnamespace = 'public'::regnamespace AND acl.grantee = 0`,
      ),
    ).toEqual([]);
  });

  it('lets each role execute exactly its functions, and PUBLIC none', async () => {
    const rows: Array<{ role: string; fn: string }> = await ds.query(
      `SELECT r.role, p.oid::regprocedure::text AS fn
         FROM pg_proc p CROSS JOIN unnest($1::text[]) AS r(role)
        WHERE p.pronamespace = 'public'::regnamespace
          AND has_function_privilege(r.role, p.oid, 'EXECUTE')
        ORDER BY 1, 2`,
      [ROLES],
    );
    const actual: Record<string, string[]> = {};
    for (const { role, fn } of rows) (actual[role] ??= []).push(fn);
    expect(actual).toEqual(FUNCTION_EXECUTE);
    expect(
      await ds.query(
        `SELECT p.proname FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
          WHERE p.pronamespace = 'public'::regnamespace AND acl.grantee = 0`,
      ),
    ).toEqual([]);
  });

  it('runs every SECURITY DEFINER function with a fixed search_path that puts pg_temp last', async () => {
    const rows: Array<{ fn: string; config: string[] | null; owner: string }> =
      await ds.query(
        `SELECT p.oid::regprocedure::text AS fn, p.proconfig AS config,
                pg_get_userbyid(p.proowner) AS owner
           FROM pg_proc p
          WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef`,
      );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toMatchObject({ owner: 'flowforge_system' });
      expect(row.config).toContain('search_path=pg_catalog, public, pg_temp');
    }
  });

  it('keeps the runtime group roles without login or bypass attributes', async () => {
    expect(
      await ds.query(
        `SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb
           FROM pg_roles WHERE rolname = ANY ($1) ORDER BY rolname`,
        [ROLES],
      ),
    ).toEqual([
      {
        rolname: 'flowforge_api_role',
        rolcanlogin: false,
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        rolcreatedb: false,
      },
      {
        rolname: 'flowforge_system',
        rolcanlogin: false,
        rolsuper: false,
        rolbypassrls: true,
        rolcreaterole: false,
        rolcreatedb: false,
      },
      {
        rolname: 'flowforge_worker_role',
        rolcanlogin: false,
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        rolcreatedb: false,
      },
    ]);
  });
});
