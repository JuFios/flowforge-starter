import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { LoginRole, provisionLoginRoles } from '../../src/database/provision';
import { API_ROLE, WORKER_ROLE } from '../../src/tenancy/roles';
import { waitForBlocked } from '../helpers/transaction-barrier';

import { openTestDataSource } from '../helpers/db';
import { clusterScopedName, testRoleUrl } from '../helpers/test-env';

/** Допоміжні ролі сценаріїв (спільні для кластера, тож з суфіксом прогону). */
const FOREIGN_ROLE = clusterScopedName('ff_foreign_test');
const EXTRA_GROUP = clusterScopedName('provision_extra_group');
const EXTRA_MEMBER = clusterScopedName('provision_member');

const API_USER = clusterScopedName('flowforge_api_provision_test');
const WORKER_USER = clusterScopedName('flowforge_worker_provision_test');
/** Випадкові на кожен прогін: якщо прибирання не встигне, на кластері не лишиться відомого пароля. */
const randomPassword = (): string => randomBytes(24).toString('hex');
const passwords = {
  first: randomPassword(),
  second: randomPassword(),
  worker: randomPassword(),
};

/**
 * `db:provision` створює login-ролі процесів ідемпотентно, з паролем-verifier (пароль у відкритому
 * вигляді на сервер не надходить), без привілеїв понад свою групову роль.
 */
describe('db:provision', () => {
  let owner: DataSource;
  const sent: string[] = [];
  const provision = (desired: LoginRole[]) =>
    owner.transaction((em) =>
      provisionLoginRoles((sql, params) => {
        sent.push(sql, JSON.stringify(params ?? []));
        return em.query(sql, params);
      }, desired),
    );
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

  it.each(['commit', 'rollback'])(
    'provisions the same first logins after a concurrent %s',
    async (outcome) => {
      const desired = roles(passwords.first).map((role) => ({
        ...role,
        user: clusterScopedName(
          'ff_race_' + (role.group === API_ROLE ? 'api' : 'worker'),
        ),
      }));
      const holder = owner.createQueryRunner();
      await holder.connect();
      await holder.startTransaction();
      try {
        await provisionLoginRoles(
          (sql, params) => holder.query(sql, params),
          desired,
        );
        const other = owner.transaction((em) =>
          provisionLoginRoles((sql, params) => em.query(sql, params), desired),
        );
        const result = Promise.allSettled([other]);
        await waitForBlocked(owner, holder);
        if (outcome === 'commit') await holder.commitTransaction();
        else await holder.rollbackTransaction();
        expect(await result).toEqual([
          { status: 'fulfilled', value: undefined },
        ]);
        for (const role of desired)
          expect(await canLogin(role.user, role.password)).toBe(true);
      } finally {
        if (holder.isTransactionActive) await holder.rollbackTransaction();
        await holder.release();
        for (const role of desired) {
          const rows = await owner.query<unknown[]>(
            'SELECT 1 FROM pg_roles WHERE rolname=$1',
            [role.user],
          );
          if (rows.length) {
            await owner.query(`DROP OWNED BY "${role.user}"`);
            await owner.query(`DROP ROLE "${role.user}"`);
          }
        }
      }
    },
  );

  it('creates both roles, which can log in with their passwords', async () => {
    await provision(roles(passwords.first));
    expect(await canLogin(API_USER, passwords.first)).toBe(true);
    expect(await canLogin(WORKER_USER, passwords.worker)).toBe(true);
  });

  it('never sends a password in plain text, only a SCRAM verifier', async () => {
    sent.length = 0;
    await provision(roles(passwords.first));
    const all = sent.join('\n');
    expect(all).not.toContain(passwords.first);
    expect(all).not.toContain(passwords.worker);
    const stored: Array<{ rolpassword: string }> = await owner.query(
      `SELECT rolpassword FROM pg_authid WHERE rolname = $1`,
      [API_USER],
    );
    expect(stored[0].rolpassword).toMatch(/^SCRAM-SHA-256\$4096:/);
  });

  it.each([
    'membership',
    'column grant',
    'schema ownership',
    'login member',
    'session setting',
    'group column grant',
  ] as const)(
    'rejects unexpected %s before rotating credentials',
    async (kind) => {
      await provision(roles(passwords.first));
      const runner = owner.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        if (kind === 'membership') {
          await runner.query(`CREATE ROLE ${EXTRA_GROUP}`);
          await runner.query(`GRANT ${EXTRA_GROUP} TO ${WORKER_USER}`);
        } else if (kind === 'login member') {
          await runner.query(`CREATE ROLE ${EXTRA_MEMBER}`);
          await runner.query(`GRANT ${WORKER_USER} TO ${EXTRA_MEMBER}`);
        } else if (kind === 'session setting') {
          await runner.query(
            `ALTER ROLE ${WORKER_USER} SET app.tenant_id = 'configuration-marker'`,
          );
        } else if (kind === 'group column grant') {
          await runner.query(`GRANT SELECT(name) ON tenants TO ${WORKER_ROLE}`);
        } else if (kind === 'column grant') {
          await runner.query(`GRANT SELECT(name) ON tenants TO ${WORKER_USER}`);
        } else {
          await runner.query(`ALTER SCHEMA public OWNER TO ${WORKER_USER}`);
        }
        const sent: string[] = [];
        await expect(
          provisionLoginRoles((sql, params) => {
            sent.push(sql);
            return runner.query(sql, params);
          }, roles(passwords.second)),
        ).rejects.toThrow(/refusing to manage/);
        expect(sent.some((sql) => /^(ALTER|CREATE) ROLE /.test(sql))).toBe(
          false,
        );
      } finally {
        await runner.rollbackTransaction();
        await runner.release();
      }
    },
  );

  it('is idempotent and rotates the password', async () => {
    await provision(roles(passwords.first));
    await provision(roles(passwords.second));
    expect(await canLogin(API_USER, passwords.second)).toBe(true);
    expect(await canLogin(API_USER, passwords.first)).toBe(false);
  });

  it('gives each role only its own group, no superuser or BYPASSRLS, and closes CONNECT to PUBLIC', async () => {
    await owner.query(`GRANT ${WORKER_ROLE} TO ${API_USER}`);
    try {
      await expect(provision(roles(passwords.second))).rejects.toThrow(
        /refusing to manage/,
      );
    } finally {
      await owner.query(`REVOKE ${WORKER_ROLE} FROM ${API_USER}`);
    }
    await provision(roles(passwords.second));
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
      await expect(provision([role])).rejects.toThrow(/invalid/);
      expect(sent).toEqual([]);
    },
  );

  it('refuses to provision while the API group can execute a worker function', async () => {
    await owner.query(
      'GRANT EXECUTE ON FUNCTION claim_job(text,integer) TO flowforge_api_role',
    );
    try {
      sent.length = 0;
      await expect(provision(roles(passwords.first))).rejects.toThrow(
        `refusing to manage ${API_USER}: unexpected group privileges`,
      );
      expect(
        sent.filter((s) => /^(ALTER|CREATE|GRANT|REVOKE)/.test(s)),
      ).toEqual([]);
    } finally {
      await owner.query(
        'REVOKE EXECUTE ON FUNCTION claim_job(text,integer) FROM flowforge_api_role',
      );
    }
  });

  it.each([
    ['the schema owner', 'flowforge'],
    ['a group role', API_ROLE],
  ])('refuses to manage %s', async (_case, user) => {
    const [{ me }]: Array<{ me: string }> = await owner.query(
      'SELECT current_user AS me',
    );
    const target = user === 'flowforge' ? me : user;
    await expect(
      provision([{ user: target, password: passwords.first, group: API_ROLE }]),
    ).rejects.toThrow(/refusing to manage/);
  });

  it.each([
    [
      'flowforge_system',
      `GRANT flowforge_system TO ${FOREIGN_ROLE}`,
      `unexpected members of flowforge_system: ${FOREIGN_ROLE}`,
    ],
    [
      'the API group with ADMIN OPTION',
      `GRANT flowforge_api_role TO ${FOREIGN_ROLE} WITH ADMIN OPTION`,
      `unexpected members of flowforge_api_role: ${FOREIGN_ROLE}`,
    ],
  ])(
    'refuses to provision while a foreign role can act as %s',
    async (_case, grant, reason) => {
      await owner.query(`CREATE ROLE ${FOREIGN_ROLE} LOGIN`);
      try {
        await owner.query(grant);
        sent.length = 0;
        await expect(provision(roles(passwords.first))).rejects.toThrow(reason);
        expect(
          sent.filter((s) => /^(ALTER|CREATE|GRANT|REVOKE)/.test(s)),
        ).toEqual([]);
      } finally {
        await owner.query(`DROP ROLE ${FOREIGN_ROLE}`);
      }
    },
  );

  // Ім'я з env збіглося з чужим логіном кластера: ротація пароля відібрала б у нього вхід, а
  // членство (за іншого способу входу, напр. cert або peer) дало б йому права застосунку.
  it('leaves alone an existing login that it did not provision', async () => {
    const bystander = clusterScopedName('ff_bystander_test');
    await owner.query(
      `CREATE ROLE ${bystander} LOGIN PASSWORD '${randomPassword()}'`,
    );
    try {
      const password = async (): Promise<string> => {
        const [row]: Array<{ rolpassword: string }> = await owner.query(
          'SELECT rolpassword FROM pg_authid WHERE rolname = $1',
          [bystander],
        );
        return row.rolpassword;
      };
      const before = await password();
      sent.length = 0;
      await expect(
        provision([
          { user: bystander, password: passwords.first, group: API_ROLE },
        ]),
      ).rejects.toThrow(
        `refusing to manage ${bystander}: the role exists but is not a member of ${API_ROLE}`,
      );
      expect(
        sent.filter((s) => /^(ALTER|CREATE|GRANT|REVOKE)/.test(s)),
      ).toEqual([]);
      expect(await password()).toBe(before);
      const [{ member }]: Array<{ member: boolean }> = await owner.query(
        `SELECT pg_has_role($1, $2, 'MEMBER') AS member`,
        [bystander, API_ROLE],
      );
      expect(member).toBe(false);
    } finally {
      // Без виправлення provision встигає видати ролі CONNECT: спершу прибрати її права в цій БД.
      await owner.query(`DROP OWNED BY ${bystander}`);
      await owner.query(`DROP ROLE ${bystander}`);
    }
  });

  it('refuses the same role for both processes', async () => {
    await expect(
      provision([
        { user: API_USER, password: passwords.first, group: API_ROLE },
        { user: API_USER, password: passwords.first, group: WORKER_ROLE },
      ]),
    ).rejects.toThrow(/different database roles/);
  });
});
