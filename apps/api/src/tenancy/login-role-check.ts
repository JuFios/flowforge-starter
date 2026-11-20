import { API_ROLE, SYSTEM_ROLE, WORKER_ROLE } from './roles';

/**
 * Login-роль отримує права через одну групу. Перевіряємо також непрямі членства,
 * власність та ACL об’єктів через залежності каталогу, включно з правами на стовпці.
 * Єдиний прямий грант provisioning — CONNECT на цільову БД без grant option.
 */
export const UNSAFE_LOGIN_SQL = `
  SELECT r.rolname FROM pg_catalog.pg_roles r
   JOIN pg_catalog.pg_database d ON d.datname = current_database()
   WHERE r.rolname = $1 AND (
     NOT r.rolcanlogin OR r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb
     OR r.rolreplication OR r.oid = d.datdba
     OR r.oid = (SELECT nspowner FROM pg_catalog.pg_namespace WHERE nspname = 'public')
     OR EXISTS (SELECT FROM pg_catalog.pg_roles g
                 WHERE g.oid <> r.oid AND g.rolname <> $2
                   AND pg_catalog.pg_has_role(r.oid, g.oid, 'MEMBER'))
     OR EXISTS (SELECT FROM pg_catalog.pg_auth_members m
                 WHERE m.roleid = r.oid OR (m.member = r.oid AND (m.admin_option OR NOT m.inherit_option)))
     OR EXISTS (SELECT FROM pg_catalog.pg_db_role_setting cfg, unnest(cfg.setconfig) entry
                 WHERE cfg.setrole IN (0,r.oid) AND cfg.setdatabase IN (0,d.oid)
                   AND split_part(entry,'=',1) IN ('app.tenant_id','role'))
     OR EXISTS (SELECT FROM pg_catalog.pg_shdepend dep
                 WHERE dep.refclassid = 'pg_catalog.pg_authid'::regclass
                   AND dep.refobjid = r.oid AND dep.deptype IN ('o','a','i','r')
                   AND dep.classid <> 'pg_catalog.pg_auth_members'::regclass
                   AND NOT (dep.classid = 'pg_catalog.pg_database'::regclass
                            AND dep.objid = d.oid AND dep.deptype = 'a'))
     OR EXISTS (SELECT FROM pg_catalog.aclexplode(d.datacl) acl
                 WHERE acl.grantee = r.oid AND (acl.privilege_type <> 'CONNECT' OR acl.is_grantable))
   )`;

/**
 * Функції схеми public, які може виконувати кожна група процесу (README, «Операції → права»).
 * Будь-яке інше ефективне право EXECUTE (прямий грант групі чи PUBLIC) — помилка конфігурації:
 * службові функції воркера (claim_job, очищення історії) з API забирали б задачі чи видаляли
 * історію всіх тенантів, а тригерні функції обліку взагалі не призначені для прямого виклику.
 */
export const GROUP_FUNCTIONS: Readonly<Record<string, readonly string[]>> = {
  [API_ROLE]: [
    'app_current_tenant()',
    'auth_tenant(text)',
    'auth_session(bytea)',
    'redeem_realtime_ticket(bytea)',
    'purge_browser_credentials(integer)',
    'due_schedule_tenants(uuid,integer)',
    'lock_tenant_usage()',
    'purge_rate_limits(integer)',
    'rate_limit_hit(text,integer,integer)',
    'tenant_limits()',
    'webhook_tenant(uuid)',
  ],
  [WORKER_ROLE]: [
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
};

const ALLOWED_FUNCTIONS_VALUES = Object.entries(GROUP_FUNCTIONS)
  .flatMap(([role, signatures]) =>
    signatures.map((signature) => `('${role}','${signature}')`),
  )
  .join(',\n     ');

/**
 * Випадковий грант PUBLIC або групі діє для кожного члена, навіть за правильної RLS. Для функцій
 * звіряються ефективні права (`has_function_privilege` враховує й PUBLIC): у public — точно за
 * переліком, у решті несистемних схем група не виконує жодної SECURITY DEFINER-функції.
 */
export const UNSAFE_GROUP_SQL = `
  WITH runtime AS (SELECT oid,rolname,rolcanlogin,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication
                     FROM pg_roles WHERE rolname = $1),
  allowed(role_name, table_name, rights) AS (VALUES
     ('flowforge_api_role','browser_sessions',ARRAY['SELECT','INSERT','DELETE']),
     ('flowforge_api_role','realtime_tickets',ARRAY['SELECT','INSERT','DELETE']),
     ('flowforge_api_role','tenants',ARRAY['SELECT','INSERT','UPDATE']),
     ('flowforge_api_role','webhook_deliveries',ARRAY['SELECT','INSERT']),
     ('flowforge_api_role','workflows',ARRAY['SELECT','INSERT','UPDATE','DELETE']),
     ('flowforge_api_role','workflow_versions',ARRAY['SELECT','INSERT']),
     ('flowforge_api_role','executions',ARRAY['SELECT','INSERT','UPDATE']),
     ('flowforge_api_role','step_runs',ARRAY['SELECT']),
     ('flowforge_api_role','jobs',ARRAY['SELECT','INSERT','UPDATE']),
     ('flowforge_api_role','notification_settings',ARRAY['SELECT','INSERT','UPDATE','DELETE']),
     ('flowforge_api_role','outbox_events',ARRAY['SELECT','UPDATE']),
     ('flowforge_api_role','outbox_attempts',ARRAY['SELECT']),
     ('flowforge_worker_role','workflow_versions',ARRAY['SELECT']),
     ('flowforge_worker_role','executions',ARRAY['SELECT','UPDATE']),
     ('flowforge_worker_role','step_runs',ARRAY['SELECT','INSERT','UPDATE']),
     ('flowforge_worker_role','jobs',ARRAY['SELECT','UPDATE']),
     ('flowforge_worker_role','notification_settings',ARRAY['SELECT']),
     ('flowforge_worker_role','outbox_events',ARRAY['SELECT','UPDATE']),
     ('flowforge_worker_role','outbox_attempts',ARRAY['SELECT','UPDATE'])),
  allowed_functions(role_name, signature) AS (VALUES
     ${ALLOWED_FUNCTIONS_VALUES}),
  relations AS (SELECT c.oid,c.relname,c.relowner,c.relacl FROM pg_class c
                 WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p','v','m','f','S'))
  SELECT 1 FROM runtime g WHERE
    g.rolcanlogin OR g.rolsuper OR g.rolbypassrls OR g.rolcreaterole OR g.rolcreatedb OR g.rolreplication
    OR EXISTS (SELECT FROM pg_auth_members m WHERE m.member=g.oid)
    OR EXISTS (SELECT FROM relations c WHERE c.relowner=g.oid)
    OR EXISTS (SELECT FROM relations c
                CROSS JOIN LATERAL aclexplode(c.relacl) a
                LEFT JOIN allowed ON role_name=g.rolname AND table_name=c.relname
                WHERE a.grantee IN (0,g.oid)
                  AND (a.is_grantable OR NOT COALESCE(a.privilege_type = ANY(allowed.rights),false)))
    OR EXISTS (SELECT FROM relations c JOIN pg_attribute col ON col.attrelid=c.oid,
                       aclexplode(col.attacl) a
                WHERE a.grantee IN (0,g.oid))
    OR EXISTS (SELECT FROM pg_proc p
                WHERE p.pronamespace='public'::regnamespace
                  AND has_function_privilege(g.oid,p.oid,'EXECUTE')
                  AND NOT EXISTS (SELECT FROM allowed_functions f
                                   WHERE f.role_name=g.rolname
                                     AND f.signature = p.proname || '(' ||
                                         replace(pg_catalog.oidvectortypes(p.proargtypes),', ',',') || ')'))
    OR EXISTS (SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                WHERE p.prosecdef AND n.nspname NOT IN ('public','pg_catalog','information_schema')
                  AND n.nspname NOT LIKE 'pg\\_%'
                  AND has_schema_privilege(g.oid,n.oid,'USAGE')
                  AND has_function_privilege(g.oid,p.oid,'EXECUTE'))
    OR has_schema_privilege(g.oid,'public','CREATE')
    OR has_database_privilege(g.oid,current_database(),'CREATE')
`;

type Query = (sql: string, params?: unknown[]) => Promise<unknown>;

/** Групові ролі, членство в яких відкриває дані тенантів. */
export const SERVICE_ROLES = [SYSTEM_ROLE, API_ROLE, WORKER_ROLE] as const;

/**
 * Найстаріший підтримуваний PostgreSQL: модель ролей спирається на правила членств PG16 (ADMIN
 * OPTION творця ролі, `inherit_option`). Раніше CREATEROLE дозволяв призначити собі будь-яку роль.
 */
export const MIN_SERVER_VERSION = 160000;

/**
 * Хто може діяти як службова роль, не будучи login-роллю від db:provision. У `flowforge_system`
 * легітимних членів немає взагалі. Член групи процесу — лише login без атрибутів і ADMIN OPTION,
 * що не входить в інші ролі й сам не має членів. Права в інших БД кластера не враховуються: на
 * одному кластері законно живуть ролі compose і тестів.
 */
export const FOREIGN_MEMBERS_SQL = `
  SELECT DISTINCT g.rolname AS "group", m.rolname AS name FROM pg_catalog.pg_auth_members am
    JOIN pg_catalog.pg_roles g ON g.oid = am.roleid
    JOIN pg_catalog.pg_roles m ON m.oid = am.member
   WHERE g.rolname = ANY ($1) AND (
     g.rolname = '${SYSTEM_ROLE}' OR am.admin_option OR NOT m.rolcanlogin
     OR m.rolsuper OR m.rolbypassrls OR m.rolcreaterole OR m.rolcreatedb OR m.rolreplication
     OR EXISTS (SELECT FROM pg_catalog.pg_auth_members o WHERE o.member = m.oid AND o.roleid <> g.oid)
     OR EXISTS (SELECT FROM pg_catalog.pg_auth_members o WHERE o.roleid = m.oid))
   ORDER BY 1, 2 LIMIT 20`;

/** Сторонні члени ролей `groups` (до 20, одним запитом), за групами в порядку `groups`. */
export async function foreignMembers(
  query: Query,
  groups: readonly string[],
): Promise<Array<{ group: string; names: string[] }>> {
  const rows = (await query(FOREIGN_MEMBERS_SQL, [groups])) as Array<{
    group: string;
    name: string;
  }>;
  return groups
    .map((group) => ({
      group,
      names: rows.filter((row) => row.group === group).map((row) => row.name),
    }))
    .filter(({ names }) => names.length > 0);
}

/** Відмова, якщо котроюсь із `groups` може діяти стороння роль. */
export async function assertNoForeignMembers(
  query: Query,
  groups: readonly string[],
): Promise<void> {
  const [found] = await foreignMembers(query, groups);
  if (found)
    throw new Error(
      `unexpected members of ${found.group}: ${found.names.join(', ')}`,
    );
}

/**
 * Службові ролі мають саме ті атрибути, з якими їх створює міграція: без входу й привілеїв, BYPASSRLS
 * допустимий лише в `flowforge_system` (його вже надала міграція іншої БД кластера). Наявну роль із
 * чужими атрибутами міграція не «лагодить»: роль із LOGIN до COMMIT зміни ще пускала б нові сесії,
 * і вони після COMMIT отримали б BYPASSRLS. Так само відмова, якщо під службовою роллю вже є сесії
 * (вони пережили б зняття LOGIN).
 */
export async function assertServiceRolesPristine(query: Query): Promise<void> {
  const rows = (await query(
    `SELECT r.rolname AS name,
            r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication
              OR (r.rolbypassrls AND r.rolname <> $2) AS unexpected,
            EXISTS (SELECT FROM pg_catalog.pg_stat_activity a WHERE a.usesysid = r.oid) AS sessions
       FROM pg_catalog.pg_roles r WHERE r.rolname = ANY ($1) ORDER BY 1`,
    [SERVICE_ROLES, SYSTEM_ROLE],
  )) as Array<{ name: string; unexpected: boolean; sessions: boolean }>;
  for (const role of rows) {
    if (role.unexpected)
      throw new Error(
        `service role ${role.name} has unexpected attributes (it can log in or holds privileges); migrations do not repair roles they did not create: drop it or reset its attributes before migrating`,
      );
    if (role.sessions)
      throw new Error(
        `service role ${role.name} has open sessions; terminate them before migrating`,
      );
  }
}

/**
 * Бази кластера (крім поточної), де `flowforge_system` уже володіє об'єктами, — до 10 за абеткою;
 * `(shared objects)` — спільні для кластера об'єкти (БД, табличні простори).
 */
const FOREIGN_OWNERSHIP_SQL = `
  SELECT DISTINCT COALESCE(db.datname, '(shared objects)') AS name
    FROM pg_catalog.pg_shdepend d
    LEFT JOIN pg_catalog.pg_database db ON db.oid = d.dbid
   WHERE d.deptype = 'o' AND d.refclassid = 'pg_catalog.pg_authid'::regclass
     AND d.refobjid = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1)
     AND d.dbid IS DISTINCT FROM
         (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database())
   ORDER BY 1 LIMIT 10`;

/**
 * Перед тим як міграція дасть `flowforge_system` BYPASSRLS: службові ролі нікому не належать, а
 * `flowforge_system` ще не володіє жодним об'єктом цієї БД. Інакше заздалегідь створений view чи
 * SECURITY DEFINER-функція з її власником читали б рядки всіх тенантів навіть після виходу автора
 * з членства.
 *
 * BYPASSRLS — атрибут ролі, а не БД, тож перше надання діє в усьому кластері: доки роль його не
 * має, вона не повинна володіти нічим і в інших БД (там її definer-функція після надання читала б
 * рядки поза політикою). Якщо роль уже має BYPASSRLS (її налаштувала міграція іншої БД кластера,
 * напр. тестової поруч із compose), надання нічого в кластері не змінює, і об'єкти тієї БД законні.
 */
export async function assertRolesUnclaimed(query: Query): Promise<void> {
  await assertNoForeignMembers(query, SERVICE_ROLES);
  const [system] = (await query(
    `SELECT rolbypassrls AS bypass FROM pg_catalog.pg_roles WHERE rolname = $1`,
    [SYSTEM_ROLE],
  )) as Array<{ bypass: boolean }>;
  if (system && !system.bypass) {
    const databases = (await query(FOREIGN_OWNERSHIP_SQL, [
      SYSTEM_ROLE,
    ])) as Array<{ name: string }>;
    if (databases.length > 0)
      throw new Error(
        `${SYSTEM_ROLE} already owns objects in other databases of this cluster: ${databases.map((d) => d.name).join(', ')}; BYPASSRLS would apply to them too, so drop them or reassign their owner before migrating`,
      );
  }
  const [{ count }] = (await query(
    `SELECT count(*)::int AS count FROM pg_catalog.pg_shdepend d
       JOIN pg_catalog.pg_database db ON db.oid = d.dbid
      WHERE db.datname = current_database() AND d.deptype = 'o'
        AND d.refclassid = 'pg_catalog.pg_authid'::regclass
        AND d.refobjid = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1)`,
    [SYSTEM_ROLE],
  )) as Array<{ count: number }>;
  if (count > 0)
    throw new Error(
      `${SYSTEM_ROLE} already owns objects in this database; drop them or reassign their owner before migrating`,
    );
}
