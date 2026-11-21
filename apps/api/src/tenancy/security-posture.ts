import { foreignMembers, SERVICE_ROLES } from './login-role-check';
import { API_ROLE, SYSTEM_ROLE, WORKER_ROLE } from './roles';

type Query = (sql: string, params?: unknown[]) => Promise<unknown>;

/**
 * Позначка «довірений власник»: роль, що володіє таблицею `migrations`, тобто та, якою оператор
 * запускає міграції. Її власні права на свої об'єкти не звіряються: вона й так власник схеми.
 */
export const MIGRATION_OWNER = '<migration owner>';

const ALL_TABLE = ['DELETE', 'INSERT', 'SELECT', 'UPDATE'];

/** Очікувана політика тенантної таблиці: колонка, з якою порівнюється контекст тенанта. */
interface TablePosture {
  /** Права, крім прав власника, за одержувачами. */
  grants: Readonly<Record<string, readonly string[]>>;
  /** Колонка політики `tenant_isolation`; без неї таблиця не має жодної політики. */
  tenantColumn?: string;
}

interface FunctionPosture {
  owner: string;
  /** Хто, крім власника, виконує функцію. */
  execute: readonly string[];
}

/**
 * Кінцевий стан каталогу після всіх міграцій (docs/architecture.md 3.3.4, «Інваріанти безпеки»). Старі міграції
 * його не імпортують. Нова таблиця чи функція в `public` без запису тут зупиняє `db:migrate` і
 * старт процесів, доки її права не описано явно.
 */
export const POSTURE: {
  tables: Readonly<Record<string, TablePosture>>;
  functions: Readonly<Record<string, FunctionPosture>>;
} = {
  tables: {
    workflow_usage: {
      tenantColumn: 'tenantId',
      grants: { [SYSTEM_ROLE]: ['SELECT', 'INSERT', 'UPDATE'] },
    },
    browser_sessions: {
      tenantColumn: 'tenantId',
      grants: {
        [API_ROLE]: ['SELECT', 'INSERT', 'DELETE'],
        [SYSTEM_ROLE]: ['SELECT', 'UPDATE', 'DELETE'],
      },
    },
    realtime_tickets: {
      tenantColumn: 'tenantId',
      grants: {
        [API_ROLE]: ['SELECT', 'INSERT', 'DELETE'],
        [SYSTEM_ROLE]: ['SELECT', 'UPDATE', 'DELETE'],
      },
    },
    tenants: {
      tenantColumn: 'id',
      grants: {
        [API_ROLE]: ['INSERT', 'SELECT', 'UPDATE'],
        [SYSTEM_ROLE]: ALL_TABLE,
      },
    },
    webhook_deliveries: {
      tenantColumn: 'tenantId',
      grants: { [API_ROLE]: ['INSERT', 'SELECT'] },
    },
    workflows: {
      tenantColumn: 'tenantId',
      grants: { [API_ROLE]: ALL_TABLE, [SYSTEM_ROLE]: ALL_TABLE },
    },
    workflow_versions: {
      tenantColumn: 'tenantId',
      grants: {
        [API_ROLE]: ['INSERT', 'SELECT'],
        [WORKER_ROLE]: ['SELECT'],
        [SYSTEM_ROLE]: ALL_TABLE,
      },
    },
    executions: {
      tenantColumn: 'tenantId',
      grants: {
        [API_ROLE]: ['INSERT', 'SELECT', 'UPDATE'],
        [WORKER_ROLE]: ['SELECT', 'UPDATE'],
        [SYSTEM_ROLE]: ALL_TABLE,
      },
    },
    step_runs: {
      tenantColumn: 'tenantId',
      grants: {
        [API_ROLE]: ['SELECT'],
        [WORKER_ROLE]: ['INSERT', 'SELECT', 'UPDATE'],
        [SYSTEM_ROLE]: ALL_TABLE,
      },
    },
    jobs: {
      tenantColumn: 'tenantId',
      grants: {
        [API_ROLE]: ['INSERT', 'SELECT', 'UPDATE'],
        [WORKER_ROLE]: ['SELECT', 'UPDATE'],
        [SYSTEM_ROLE]: ALL_TABLE,
      },
    },
    notification_settings: {
      tenantColumn: 'tenantId',
      grants: {
        [API_ROLE]: ALL_TABLE,
        [WORKER_ROLE]: ['SELECT'],
        [SYSTEM_ROLE]: ALL_TABLE,
      },
    },
    outbox_events: {
      tenantColumn: 'tenantId',
      grants: {
        [API_ROLE]: ['SELECT', 'UPDATE'],
        [WORKER_ROLE]: ['SELECT', 'UPDATE'],
        [SYSTEM_ROLE]: ALL_TABLE,
      },
    },
    outbox_attempts: {
      tenantColumn: 'tenantId',
      grants: {
        [API_ROLE]: ['SELECT'],
        [WORKER_ROLE]: ['SELECT', 'UPDATE'],
        [SYSTEM_ROLE]: ALL_TABLE,
      },
    },
    tenant_usage: {
      tenantColumn: 'tenantId',
      grants: { [SYSTEM_ROLE]: ALL_TABLE },
    },
    tenant_outbox_usage: {
      tenantColumn: 'tenantId',
      grants: { [SYSTEM_ROLE]: ALL_TABLE },
    },
    limit_defaults: { grants: { [SYSTEM_ROLE]: ALL_TABLE } },
    rate_limit_buckets: { grants: { [SYSTEM_ROLE]: ALL_TABLE } },
    migrations: { grants: {} },
    migrations_id_seq: { grants: {} },
  },
  functions: {
    'app_current_tenant()': {
      owner: MIGRATION_OWNER,
      execute: [API_ROLE, WORKER_ROLE, SYSTEM_ROLE],
    },
    'purge_browser_credentials(integer)': {
      owner: SYSTEM_ROLE,
      execute: [API_ROLE],
    },
    'auth_session(bytea)': { owner: SYSTEM_ROLE, execute: [API_ROLE] },
    'redeem_realtime_ticket(bytea)': {
      owner: SYSTEM_ROLE,
      execute: [API_ROLE],
    },
    'bump_execution_revision()': { owner: MIGRATION_OWNER, execute: [] },
    'notify_execution()': { owner: MIGRATION_OWNER, execute: [] },
    'touch_step_execution()': { owner: MIGRATION_OWNER, execute: [] },
    'notify_session_revoked()': { owner: MIGRATION_OWNER, execute: [] },
    'auth_tenant(text)': { owner: SYSTEM_ROLE, execute: [API_ROLE] },
    'webhook_tenant(uuid)': { owner: SYSTEM_ROLE, execute: [API_ROLE] },
    'due_schedule_tenants(uuid,integer)': {
      owner: SYSTEM_ROLE,
      execute: [API_ROLE],
    },
    'lock_tenant_usage()': { owner: SYSTEM_ROLE, execute: [API_ROLE] },
    'tenant_limits()': { owner: SYSTEM_ROLE, execute: [API_ROLE] },
    'rate_limit_hit(text,integer,integer)': {
      owner: SYSTEM_ROLE,
      execute: [API_ROLE],
    },
    'purge_rate_limits(integer)': { owner: SYSTEM_ROLE, execute: [API_ROLE] },
    'claim_job(text,integer)': { owner: SYSTEM_ROLE, execute: [WORKER_ROLE] },
    'expired_lease_tenants(uuid[],integer)': {
      owner: SYSTEM_ROLE,
      execute: [WORKER_ROLE],
    },
    'purge_finished_jobs(integer,integer)': {
      owner: SYSTEM_ROLE,
      execute: [WORKER_ROLE],
    },
    'purge_execution_history(integer,integer)': {
      owner: SYSTEM_ROLE,
      execute: [WORKER_ROLE],
    },
    'queue_depth_by_tenant()': { owner: SYSTEM_ROLE, execute: [WORKER_ROLE] },
    // Тригерні функції обліку: їх викликає лише тригер.
    'tenant_usage_on_job()': { owner: SYSTEM_ROLE, execute: [] },
    'close_cancelled_attempt()': { owner: SYSTEM_ROLE, execute: [] },
    'close_paused_attempt()': { owner: SYSTEM_ROLE, execute: [] },
    'outbox_usage()': { owner: SYSTEM_ROLE, execute: [] },
    'outbox_usage_on_tenant()': { owner: SYSTEM_ROLE, execute: [] },
    'outbox_attempt_history()': { owner: SYSTEM_ROLE, execute: [] },
    'execution_terminal_cycle()': { owner: SYSTEM_ROLE, execute: [] },
    'outbox_on_execution()': { owner: SYSTEM_ROLE, execute: [] },
    'claim_outbox_event(text,integer,integer)': {
      owner: SYSTEM_ROLE,
      execute: [WORKER_ROLE],
    },
    'purge_delivered_events(integer,integer)': {
      owner: SYSTEM_ROLE,
      execute: [WORKER_ROLE],
    },
    'finish_outbox_event(uuid,uuid,double precision,text,integer)': {
      owner: SYSTEM_ROLE,
      execute: [WORKER_ROLE],
    },
    'outbox_backlog()': { owner: SYSTEM_ROLE, execute: [WORKER_ROLE] },
    'tenant_usage_on_tenant()': { owner: SYSTEM_ROLE, execute: [] },
    'tenant_usage_on_defaults()': { owner: SYSTEM_ROLE, execute: [] },
    'workflow_quota()': { owner: SYSTEM_ROLE, execute: [] },
  },
};

/** Найбільше імен в одному повідомленні: перелік без даних тенантів і без меж не росте. */
const MAX_REPORTED = 20;

/** Атрибути службових ролей: усі без входу й привілеїв, BYPASSRLS — лише в системної. */
const ROLE_ATTRIBUTES_SQL = `
  SELECT s.name, r.oid IS NOT NULL AS present,
         COALESCE(r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole
                  OR r.rolreplication OR r.rolbypassrls <> (s.name = $2), false) AS unexpected,
         EXISTS (SELECT FROM pg_catalog.pg_stat_activity a WHERE a.usesysid = r.oid) AS sessions,
         EXISTS (SELECT FROM pg_catalog.pg_db_role_setting cfg WHERE cfg.setrole = r.oid) AS settings
    FROM unnest($1::text[]) AS s(name)
    LEFT JOIN pg_catalog.pg_roles r ON r.rolname = s.name
   ORDER BY 1`;

/**
 * Об'єкти схеми public з власником і всіма правами, крім прав самого власника. Одержувач — будь-яка
 * роль, включно з PUBLIC: стороння роль із грантом (прямим чи через ALTER DEFAULT PRIVILEGES) —
 * такий самий провал, як зайве право службової ролі. Типи не звіряються: USAGE на тип нічого не відкриває.
 */
const OBJECTS_SQL = `
  WITH owner AS (SELECT c.relowner AS oid FROM pg_catalog.pg_class c
                  WHERE c.relname = 'migrations' AND c.relnamespace = 'public'::regnamespace),
  objects AS (
    SELECT 'function' AS kind, p.oid::regprocedure::text AS name, p.proowner AS owner,
           COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner)) AS acl
      FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace
    UNION ALL
    SELECT 'relation', c.relname::text, c.relowner,
           COALESCE(c.relacl, pg_catalog.acldefault(
             CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END::"char", c.relowner))
      FROM pg_catalog.pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S'))
  SELECT o.kind, o.name,
         CASE WHEN o.owner = (SELECT oid FROM owner) THEN '${MIGRATION_OWNER}'
              ELSE pg_catalog.pg_get_userbyid(o.owner) END AS owner,
         COALESCE(pg_catalog.json_agg(pg_catalog.json_build_object(
                    'grantee', CASE WHEN a.grantee = 0 THEN 'PUBLIC'
                                    ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
                    'privilege', a.privilege_type, 'grantable', a.is_grantable))
                    FILTER (WHERE a.grantee IS NOT NULL), '[]') AS grants
    FROM objects o
    LEFT JOIN LATERAL pg_catalog.aclexplode(o.acl) a ON a.grantee <> o.owner
   GROUP BY 1, 2, 3
   ORDER BY 1, 2`;

/** Права на окремі стовпці: міграції їх не видають ніколи. */
const COLUMN_GRANTS_SQL = `
  SELECT DISTINCT c.relname AS name FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
   WHERE c.relnamespace = 'public'::regnamespace AND a.attacl IS NOT NULL AND NOT a.attisdropped
   ORDER BY 1 LIMIT ${MAX_REPORTED}`;

/** Хто, крім власника схеми й довіреного власника, створює об'єкти в public. */
const SCHEMA_CREATE_SQL = `
  SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC'
                       ELSE pg_catalog.pg_get_userbyid(a.grantee) END AS name
    FROM pg_catalog.pg_namespace n, pg_catalog.aclexplode(n.nspacl) a
   WHERE n.nspname = 'public' AND a.grantee <> n.nspowner
     AND (a.privilege_type = 'CREATE' OR a.is_grantable)
     AND a.grantee IS DISTINCT FROM (SELECT c.relowner FROM pg_catalog.pg_class c
                                      WHERE c.relname = 'migrations'
                                        AND c.relnamespace = 'public'::regnamespace)
   ORDER BY 1 LIMIT ${MAX_REPORTED}`;

/** RLS і всі політики таблиць public. */
const POLICIES_SQL = `
  SELECT c.relname AS "table", c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
         COALESCE(pg_catalog.json_agg(pg_catalog.json_build_object(
                    'name', p.polname, 'permissive', p.polpermissive, 'cmd', p.polcmd,
                    'roles', p.polroles::oid[]::text[],
                    'qual', pg_catalog.pg_get_expr(p.polqual, p.polrelid),
                    'check', pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid)))
                    FILTER (WHERE p.oid IS NOT NULL), '[]') AS policies
    FROM pg_catalog.pg_class c
    LEFT JOIN pg_catalog.pg_policy p ON p.polrelid = c.oid
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
   GROUP BY 1, 2, 3
   ORDER BY 1`;

/**
 * Об'єкти цієї БД (і спільні для кластера), якими володіють службові ролі або на які вони мають
 * права, поза таблицями й функціями public (їх звіряє OBJECTS_SQL) і самою схемою public. View чи
 * definer-функція системної ролі в іншій схемі читали б усіх тенантів в обхід політик.
 */
const FOREIGN_OBJECTS_SQL = `
  SELECT DISTINCT pg_catalog.pg_get_userbyid(d.refobjid) AS role,
         COALESCE(pg_catalog.pg_describe_object(d.classid, d.objid, d.objsubid),
                  '(object in another database)') AS object
    FROM pg_catalog.pg_shdepend d
   WHERE d.refclassid = 'pg_catalog.pg_authid'::regclass
     AND d.refobjid IN (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = ANY ($1))
     AND d.deptype IN ('o', 'a')
     AND d.dbid IN (0, (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database()))
     AND NOT (d.classid = 'pg_catalog.pg_proc'::regclass
              AND EXISTS (SELECT FROM pg_catalog.pg_proc p
                           WHERE p.oid = d.objid AND p.pronamespace = 'public'::regnamespace))
     AND NOT (d.classid = 'pg_catalog.pg_class'::regclass
              AND EXISTS (SELECT FROM pg_catalog.pg_class c
                           WHERE c.oid = d.objid AND c.relnamespace = 'public'::regnamespace))
     AND NOT (d.classid = 'pg_catalog.pg_namespace'::regclass
              AND d.objid = 'public'::regnamespace AND d.deptype = 'a')
   ORDER BY 1, 2 LIMIT ${MAX_REPORTED}`;

interface ObjectRow {
  kind: 'function' | 'relation';
  name: string;
  owner: string;
  grants: Array<{ grantee: string; privilege: string; grantable: boolean }>;
}

interface PolicyRow {
  table: string;
  rls: boolean;
  forced: boolean;
  policies: Array<{
    name: string;
    permissive: boolean;
    cmd: string;
    /** oid ролей текстом (json віддає oid рядком); `0` — PUBLIC. */
    roles: string[];
    qual: string | null;
    check: string | null;
  }>;
}

/** Вираз політики так, як його друкує `pg_get_expr` (PostgreSQL 16+). */
function tenantExpression(column: string): string {
  const quoted = column === 'id' ? 'id' : `"${column}"`;
  return `(${quoted} = app_current_tenant())`;
}

function grantKey(grantee: string, privilege: string): string {
  return `${grantee}:${privilege}`;
}

function checkObject(row: ObjectRow, problems: string[]): void {
  const label = `${row.kind} ${row.name}`;
  const expected =
    row.kind === 'function'
      ? POSTURE.functions[row.name]
      : POSTURE.tables[row.name];
  for (const grant of row.grants)
    if (grant.grantable)
      problems.push(`${label} lets ${grant.grantee} grant ${grant.privilege}`);

  if (!expected) {
    // Невідомий об'єкт допустимий лише як службовий об'єкт довіреного власника без чужих прав.
    if (row.owner !== MIGRATION_OWNER)
      problems.push(`unexpected ${label} owned by ${row.owner}`);
    for (const grant of row.grants)
      problems.push(
        `unexpected ${label} grants ${grant.privilege} to ${grant.grantee}`,
      );
    return;
  }

  const expectedOwner = 'owner' in expected ? expected.owner : MIGRATION_OWNER;
  if (row.owner !== expectedOwner)
    problems.push(`${label} is owned by ${row.owner}, not ${expectedOwner}`);

  const allowed = new Set<string>();
  if ('execute' in expected)
    for (const role of expected.execute) allowed.add(grantKey(role, 'EXECUTE'));
  else
    for (const [role, privileges] of Object.entries(expected.grants))
      for (const privilege of privileges)
        allowed.add(grantKey(role, privilege));
  // Власник, відмінний від довіреного (системна роль), має свої права як власник, не як грант.
  allowed.delete(grantKey(row.owner, 'EXECUTE'));

  const actual = new Set(
    row.grants.map((g) => grantKey(g.grantee, g.privilege)),
  );
  for (const key of actual)
    if (!allowed.has(key))
      problems.push(`${label} grants ${key.replace(':', ' ')} unexpectedly`);
  for (const key of allowed)
    if (!actual.has(key))
      problems.push(`${label} is missing the grant ${key.replace(':', ' ')}`);
}

function checkPolicies(row: PolicyRow, problems: string[]): void {
  const column = POSTURE.tables[row.table]?.tenantColumn;
  if (!column) {
    for (const policy of row.policies)
      problems.push(`unexpected policy ${policy.name} on table ${row.table}`);
    return;
  }
  if (!row.rls || !row.forced)
    problems.push(`table ${row.table} does not force row-level security`);
  const expression = tenantExpression(column);
  const isolation = row.policies.filter(
    (p) =>
      p.name === 'tenant_isolation' &&
      p.permissive &&
      p.cmd === '*' &&
      p.roles.length === 1 &&
      p.roles[0] === '0' &&
      p.qual === expression &&
      p.check === expression,
  );
  if (isolation.length !== 1)
    problems.push(`table ${row.table} lacks the exact tenant_isolation policy`);
  for (const policy of row.policies)
    if (!isolation.includes(policy))
      problems.push(`unexpected policy ${policy.name} on table ${row.table}`);
}

/**
 * Інваріанти безпеки каталогу (docs/architecture.md 3.3.4, «Інваріанти безпеки»): службові ролі (I-1), точні
 * права на кожен об'єкт public для будь-якого одержувача (I-2) і точний набір політик (I-3).
 * Перелік порушень порожній — каталог відповідає `POSTURE`. Повідомлення містять лише імена
 * об'єктів і ролей. Викликається в транзакції `db:migrate` перед COMMIT і на старті процесів.
 */
export async function findPostureViolations(query: Query): Promise<string[]> {
  const problems: string[] = [];

  const roles = (await query(ROLE_ATTRIBUTES_SQL, [
    SERVICE_ROLES,
    SYSTEM_ROLE,
  ])) as Array<{
    name: string;
    present: boolean;
    unexpected: boolean;
    sessions: boolean;
    settings: boolean;
  }>;
  for (const role of roles) {
    if (!role.present) problems.push(`service role ${role.name} is missing`);
    if (role.unexpected)
      problems.push(`service role ${role.name} has unexpected attributes`);
    if (role.sessions)
      problems.push(`service role ${role.name} has open sessions`);
    if (role.settings)
      problems.push(`service role ${role.name} has role-specific settings`);
  }
  for (const { group, names } of await foreignMembers(query, SERVICE_ROLES))
    for (const name of names)
      problems.push(`unexpected member ${name} of ${group}`);

  const objects = (await query(OBJECTS_SQL)) as ObjectRow[];
  if (!objects.some((o) => o.kind === 'relation' && o.name === 'migrations'))
    problems.push('the migrations table is missing from schema public');
  const seen = new Set(objects.map((o) => `${o.kind} ${o.name}`));
  for (const row of objects) checkObject(row, problems);
  for (const name of Object.keys(POSTURE.functions))
    if (!seen.has(`function ${name}`))
      problems.push(`function ${name} is missing`);
  for (const name of Object.keys(POSTURE.tables))
    if (!seen.has(`relation ${name}`))
      problems.push(`relation ${name} is missing`);

  for (const { name } of (await query(COLUMN_GRANTS_SQL)) as Array<{
    name: string;
  }>)
    problems.push(`table ${name} has column-level grants`);
  for (const { name } of (await query(SCHEMA_CREATE_SQL)) as Array<{
    name: string;
  }>)
    problems.push(`${name} can create objects in schema public`);

  const policies = (await query(POLICIES_SQL)) as PolicyRow[];
  const inspected = new Set(policies.map((row) => row.table));
  for (const [name, table] of Object.entries(POSTURE.tables))
    if (table.tenantColumn && !inspected.has(name))
      problems.push(
        `tenant relation ${name} is not a table inspected for row-level security`,
      );
  for (const row of policies) checkPolicies(row, problems);

  for (const { role, object } of (await query(FOREIGN_OBJECTS_SQL, [
    SERVICE_ROLES,
  ])) as Array<{ role: string; object: string }>)
    problems.push(`service role ${role} owns or has rights on ${object}`);

  return problems.slice(0, MAX_REPORTED);
}

/** Відмова з переліком порушень (без секретів і даних тенантів). */
export async function assertSecurityPosture(query: Query): Promise<void> {
  const problems = await findPostureViolations(query);
  if (problems.length > 0)
    throw new Error(
      `database security posture violated:\n  ${problems.join('\n  ')}`,
    );
}
