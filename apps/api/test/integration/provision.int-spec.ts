import { DataSource } from 'typeorm';
import { LoginRole, provisionLoginRoles } from '../../src/database/provision';
import { API_ROLE, WORKER_ROLE } from '../../src/tenancy/roles';
import { openTestDataSource } from '../helpers/db';
import { testRoleUrl } from '../helpers/test-env';

const API_USER = 'flowforge_api_provision_test';
const WORKER_USER = 'flowforge_worker_provision_test';
const passwords = {
  first: 'firstApiPassword0123456789',
  second: 'secondApiPassword0123456789',
  worker: 'workerPassword0123456789abc',
};

/**
 * `db:provision` створює login-ролі процесів ідемпотентно, з паролем-verifier (пароль у відкритому
 * вигляді на сервер не надходить), без привілеїв понад свою групову роль.
 */
describe('db:provision', () => {
  let owner: DataSource;
  const sent: string[] = [];
  const query = (sql: string, params?: unknown[]) => {
    sent.push(sql, JSON.stringify(params ?? []));
    return owner.query(sql, params);
  };
  const roles = (apiPassword: string): LoginRole[] => [
    { user: API_USER, password: apiPassword, group: API_ROLE },
    { user: WORKER_USER, password: passwords.worker, group: WORKER_ROLE },
  ];

  async function canLogin(user: string, password: string): Promise<boolean> {
    const ds = new DataSource({
      type: 'postgres',
      url: testRoleUrl(user, password),
    });
    try {
      await ds.initialize();
      const [{ me }]: Array<{ me: string }> = await ds.query(
        'SELECT current_user AS me',
      );
      return me === user;
    } catch {
      return false;
    } finally {
      if (ds.isInitialized) await ds.destroy();
    }
  }

  beforeAll(async () => {
    owner = await openTestDataSource();
  });

  afterAll(async () => {
    const [{ db }]: Array<{ db: string }> = await owner.query(
      'SELECT current_database() AS db',
    );
    for (const user of [API_USER, WORKER_USER])
      await owner.query(
        `DO $$ BEGIN
           IF EXISTS (SELECT FROM pg_roles WHERE rolname = '${user}') THEN
             REVOKE CONNECT ON DATABASE "${db}" FROM ${user};
             DROP ROLE ${user};
           END IF;
         END $$`,
      );
    await owner.destroy();
  });

  it('creates both roles, which can log in with their passwords', async () => {
    await provisionLoginRoles(query, roles(passwords.first));
    expect(await canLogin(API_USER, passwords.first)).toBe(true);
    expect(await canLogin(WORKER_USER, passwords.worker)).toBe(true);
  });

  it('never sends a password in plain text, only a SCRAM verifier', async () => {
    sent.length = 0;
    await provisionLoginRoles(query, roles(passwords.first));
    const all = sent.join('\n');
    expect(all).not.toContain(passwords.first);
    expect(all).not.toContain(passwords.worker);
    const stored: Array<{ rolpassword: string }> = await owner.query(
      `SELECT rolpassword FROM pg_authid WHERE rolname = $1`,
      [API_USER],
    );
    expect(stored[0].rolpassword).toMatch(/^SCRAM-SHA-256\$4096:/);
  });

  it('is idempotent and rotates the password', async () => {
    await provisionLoginRoles(query, roles(passwords.first));
    await provisionLoginRoles(query, roles(passwords.second));
    expect(await canLogin(API_USER, passwords.second)).toBe(true);
    expect(await canLogin(API_USER, passwords.first)).toBe(false);
  });

  it('gives each role only its own group, no superuser or BYPASSRLS, and closes CONNECT to PUBLIC', async () => {
    await owner.query(`GRANT ${WORKER_ROLE} TO ${API_USER}`);
    await provisionLoginRoles(query, roles(passwords.second));
    const rows: Array<Record<string, unknown>> = await owner.query(
      `SELECT r.rolname, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb,
              pg_has_role(r.rolname, $3, 'MEMBER') AS api,
              pg_has_role(r.rolname, $4, 'MEMBER') AS worker
         FROM pg_roles r WHERE r.rolname IN ($1, $2) ORDER BY r.rolname`,
      [API_USER, WORKER_USER, API_ROLE, WORKER_ROLE],
    );
    expect(rows).toEqual([
      {
        rolname: API_USER,
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        rolcreatedb: false,
        api: true,
        worker: false,
      },
      {
        rolname: WORKER_USER,
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        rolcreatedb: false,
        api: false,
        worker: true,
      },
    ]);
    const [{ open }]: Array<{ open: boolean }> = await owner.query(
      `SELECT EXISTS (SELECT FROM pg_database d, aclexplode(d.datacl) acl
                       WHERE d.datname = current_database() AND acl.grantee = 0
                         AND acl.privilege_type = 'CONNECT') AS open`,
    );
    expect(open).toBe(false);
  });

  it.each([
    ['a weak password', { user: API_USER, password: 'short', group: API_ROLE }],
    [
      'a password with characters that break the connection URL',
      {
        user: API_USER,
        password: 'p@ss/word:0123456789abcdef',
        group: API_ROLE,
      },
    ],
    [
      'a role name that needs quoting',
      {
        user: 'Robert"; DROP ROLE x; --',
        password: passwords.first,
        group: API_ROLE,
      },
    ],
  ] as Array<[string, LoginRole]>)(
    'rejects %s without touching the database',
    async (_case, role) => {
      sent.length = 0;
      await expect(provisionLoginRoles(query, [role])).rejects.toThrow(
        /invalid/,
      );
      expect(sent).toEqual([]);
    },
  );

  it.each([
    ['the schema owner', 'flowforge'],
    ['a group role', API_ROLE],
  ])('refuses to manage %s', async (_case, user) => {
    const [{ me }]: Array<{ me: string }> = await owner.query(
      'SELECT current_user AS me',
    );
    const target = user === 'flowforge' ? me : user;
    await expect(
      provisionLoginRoles(query, [
        { user: target, password: passwords.first, group: API_ROLE },
      ]),
    ).rejects.toThrow(/refusing to manage/);
  });

  it('refuses the same role for both processes', async () => {
    await expect(
      provisionLoginRoles(query, [
        { user: API_USER, password: passwords.first, group: API_ROLE },
        { user: API_USER, password: passwords.first, group: WORKER_ROLE },
      ]),
    ).rejects.toThrow(/different database roles/);
  });
});
