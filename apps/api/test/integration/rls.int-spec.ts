import { DataSource, EntityManager } from 'typeorm';
import { hashApiKey } from '../../src/auth/api-key.guard';
import { Execution, Job, StepRun, Workflow } from '../../src/entities';
import {
  createExecution,
  createTenant,
  createWorkflow,
  openTestDataSource,
  truncateAll,
} from '../helpers/db';
import { testApiDatabaseUrl, testWorkerDatabaseUrl } from '../helpers/test-env';

/** Тенантні таблиці й колонка, за якою вони належать тенанту. */
const TABLES: Array<[string, string]> = [
  ['tenants', 'id'],
  ['workflows', '"tenantId"'],
  ['workflow_versions', '"tenantId"'],
  ['executions', '"tenantId"'],
  ['step_runs', '"tenantId"'],
  ['jobs', '"tenantId"'],
];

interface TenantData {
  tenantId: string;
  workflowId: string;
  executionId: string;
  jobId: string;
}

/**
 * Ізоляція на рівні БД, в обхід шару сервісів (ТЗ 3.3.4, розд. 6): прямий SQL тією самою роллю,
 * якою ходить застосунок (DATABASE_URL), не бачить і не змінює даних іншого тенанта, а без
 * контексту тенанта не бачить нічого.
 */
describe('tenant isolation in Postgres (direct SQL as the application role)', () => {
  let owner: DataSource;
  let app: DataSource;
  let a: TenantData;
  let b: TenantData;

  async function seed(name: string): Promise<TenantData> {
    const { tenant } = await createTenant(owner, name);
    const wf = await createWorkflow(owner, tenant.id, `wf-${name}`);
    const execution = await createExecution(owner, wf, {
      input: { owner: name },
    });
    await owner.getRepository(StepRun).insert({
      executionId: execution.id,
      tenantId: tenant.id,
      stepIndex: 0,
      stepId: 'say',
      status: 'succeeded',
    } as never);
    const job = await owner
      .getRepository(Job)
      .save({ tenantId: tenant.id, executionId: execution.id });
    return {
      tenantId: tenant.id,
      workflowId: wf.id,
      executionId: execution.id,
      jobId: job.id,
    };
  }

  beforeAll(async () => {
    owner = await openTestDataSource();
    app = await new DataSource({
      type: 'postgres',
      url: process.env.DATABASE_URL,
    }).initialize();
  });

  beforeEach(async () => {
    await truncateAll(owner);
    a = await seed('a');
    b = await seed('b');
  });

  afterAll(async () => {
    await app.destroy();
    await truncateAll(owner);
    await owner.destroy();
  });

  /** Транзакція застосунку в контексті тенанта (як TenantDb.run); завжди відкочується. */
  async function asTenant<T>(
    tenantId: string | null,
    fn: (em: EntityManager) => Promise<T>,
  ): Promise<T> {
    const runner = app.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      if (tenantId !== null)
        await runner.query(`SELECT set_config('app.tenant_id', $1, true)`, [
          tenantId,
        ]);
      return await fn(runner.manager);
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  }

  const count = async (
    em: EntityManager,
    table: string,
    column?: string,
    tenantId?: string,
  ): Promise<number> => {
    const [{ n }]: Array<{ n: number }> = await em.query(
      column
        ? `SELECT count(*)::int AS n FROM ${table} WHERE ${column} = $1`
        : `SELECT count(*)::int AS n FROM ${table}`,
      column ? [tenantId] : [],
    );
    return n;
  };

  it.each(TABLES)(
    'a query without tenant context sees no rows of %s',
    async (table) => {
      expect(await asTenant(null, (em) => count(em, table))).toBe(0);
    },
  );

  it.each(TABLES)(
    'a query with a malformed tenant context sees no rows of %s',
    async (table) => {
      expect(await asTenant('not-a-uuid', (em) => count(em, table))).toBe(0);
    },
  );

  it.each(TABLES)(
    'tenant A sees none of the rows of tenant B in %s',
    async (table, column) => {
      const seen = await asTenant(a.tenantId, (em) =>
        count(em, table, column, b.tenantId),
      );
      expect(seen).toBe(0);
    },
  );

  it('tenant A cannot change or delete rows of tenant B', async () => {
    const changed = await asTenant(a.tenantId, async (em) => {
      const results: number[] = [];
      for (const [sql, params] of [
        [
          `UPDATE executions SET status = 'failed' WHERE id = $1`,
          [b.executionId],
        ],
        [`UPDATE jobs SET attempts = 99 WHERE id = $1`, [b.jobId]],
        [
          `UPDATE workflows SET name = 'hijacked' WHERE id = $1`,
          [b.workflowId],
        ],
        [`DELETE FROM workflows WHERE id = $1`, [b.workflowId]],
      ] as Array<[string, unknown[]]>) {
        const [, affected]: [unknown, number] = await em.query(sql, params);
        results.push(affected);
      }
      return results;
    });
    expect(changed).toEqual([0, 0, 0, 0]);
    expect(
      await owner.getRepository(Workflow).findOneByOrFail({ id: b.workflowId }),
    ).toMatchObject({ name: 'wf-b' });
    expect(
      await owner
        .getRepository(Execution)
        .findOneByOrFail({ id: b.executionId }),
    ).toMatchObject({ status: 'pending' });
  });

  it('tenant A cannot create rows in the name of tenant B', async () => {
    await expect(
      asTenant(a.tenantId, (em) =>
        em.query(
          `INSERT INTO workflows ("tenantId", name, steps) VALUES ($1, 'planted', '[]')`,
          [b.tenantId],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('no row of one tenant can reference an execution of another, even when written by the owner', async () => {
    await expect(
      owner.query(
        `INSERT INTO jobs ("tenantId", "executionId", status) VALUES ($1, $2, 'queued')`,
        [a.tenantId, b.executionId],
      ),
    ).rejects.toThrow(/foreign key/);
  });
});

/** Ролі процесів і те, чого кожна з них робити не може (матриця прав — db-acl.int-spec). */
const ROLES: Array<{
  name: string;
  url: () => string;
  /** Операції без права: Postgres відмовляє ще до RLS. */
  denied: string[];
  /** Дозволена зміна, що доводить: RLS пропускає свій рядок і не пропускає чужий. */
  update: string;
}> = [
  {
    name: 'API',
    url: testApiDatabaseUrl,
    denied: [
      `UPDATE step_runs SET status = 'failed'`,
      `DELETE FROM executions`,
      `DELETE FROM jobs`,
      `SELECT * FROM claim_fifo_candidate()`,
      `SELECT purge_finished_jobs(1, 1)`,
    ],
    update: `UPDATE executions SET error = 'touched' WHERE id = $1`,
  },
  {
    name: 'worker',
    url: testWorkerDatabaseUrl,
    denied: [
      `SELECT * FROM tenants`,
      `SELECT * FROM workflows`,
      `INSERT INTO executions ("tenantId", "workflowId") VALUES (gen_random_uuid(), gen_random_uuid())`,
      `DELETE FROM jobs`,
      `SELECT auth_tenant('x')`,
      `SELECT webhook_tenant(gen_random_uuid())`,
    ],
    update: `UPDATE executions SET error = 'touched' WHERE id = $1`,
  },
];

describe.each(ROLES)('the $name database role', ({ url, denied, update }) => {
  let owner: DataSource;
  let role: DataSource;
  let a: { tenantId: string; executionId: string };
  let b: { tenantId: string; executionId: string };

  beforeAll(async () => {
    owner = await openTestDataSource();
    role = await new DataSource({ type: 'postgres', url: url() }).initialize();
  });

  beforeEach(async () => {
    await truncateAll(owner);
    const seed = async (name: string) => {
      const { tenant } = await createTenant(owner, name);
      const wf = await createWorkflow(owner, tenant.id, name);
      const e = await createExecution(owner, wf);
      return { tenantId: tenant.id, executionId: e.id };
    };
    a = await seed('a');
    b = await seed('b');
  });

  afterAll(async () => {
    await role.destroy();
    await truncateAll(owner);
    await owner.destroy();
  });

  async function inTenant<T>(
    tenantId: string,
    fn: (em: EntityManager) => Promise<T>,
  ): Promise<T> {
    return role.transaction(async (em) => {
      await em.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        tenantId,
      ]);
      return fn(em);
    });
  }

  it('changes its own tenant row and not the row of another tenant', async () => {
    const affected = await inTenant(a.tenantId, async (em) => {
      const [, own]: [unknown, number] = await em.query(update, [
        a.executionId,
      ]);
      const [, foreign]: [unknown, number] = await em.query(update, [
        b.executionId,
      ]);
      return { own, foreign };
    });
    expect(affected).toEqual({ own: 1, foreign: 0 });
    const rows: Array<{ id: string; error: string | null }> = await owner.query(
      `SELECT id, error FROM executions WHERE id = ANY ($1) ORDER BY id`,
      [[a.executionId, b.executionId]],
    );
    expect(Object.fromEntries(rows.map((r) => [r.id, r.error]))).toEqual({
      [a.executionId]: 'touched',
      [b.executionId]: null,
    });
  });

  it.each(denied)('is denied %s', async (sql) => {
    await expect(inTenant(a.tenantId, (em) => em.query(sql))).rejects.toThrow(
      /permission denied/,
    );
  });

  it.each([
    `TRUNCATE jobs`,
    `ALTER TABLE jobs DISABLE ROW LEVEL SECURITY`,
    `ALTER TABLE jobs NO FORCE ROW LEVEL SECURITY`,
    `DROP POLICY tenant_isolation ON jobs`,
    `SET ROLE flowforge_system`,
    `CREATE TABLE public.planted (id int)`,
    `CREATE FUNCTION public.app_current_tenant_planted() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid'`,
  ])('cannot bypass row-level security: %s', async (sql) => {
    await expect(inTenant(a.tenantId, (em) => em.query(sql))).rejects.toThrow(
      /permission denied|must be owner|must be member|not allowed|privilege/,
    );
  });
});

describe('SECURITY DEFINER functions', () => {
  let owner: DataSource;
  let apiRole: DataSource;

  beforeAll(async () => {
    owner = await openTestDataSource();
    apiRole = await new DataSource({
      type: 'postgres',
      url: testApiDatabaseUrl(),
    }).initialize();
  });

  afterAll(async () => {
    await apiRole.destroy();
    await truncateAll(owner);
    await owner.destroy();
  });

  it('ignore objects planted in pg_temp by the caller', async () => {
    await truncateAll(owner);
    const { tenant, apiKey } = await createTenant(owner, 'real');
    const runner = apiRole.createQueryRunner();
    await runner.connect();
    try {
      // Тимчасові таблиці з іменами справжніх: без явного pg_temp у search_path функції
      // шукали б їх першими й автентифікували б підкинутого тенанта.
      await runner.query(
        `CREATE TEMP TABLE tenants (id uuid, "apiKeyHash" varchar)`,
      );
      const planted = '0'.repeat(64);
      await runner.query(
        `INSERT INTO pg_temp.tenants VALUES (gen_random_uuid(), $1)`,
        [planted],
      );
      const lookup = async (hash: string) =>
        (
          (await runner.query(`SELECT auth_tenant($1) AS id`, [
            hash,
          ])) as Array<{
            id: string | null;
          }>
        )[0].id;
      const fake = await lookup(planted);
      const real = await lookup(hashApiKey(apiKey));
      expect(fake).toBeNull();
      expect(real).toBe(tenant.id);
    } finally {
      await runner.release();
    }
  });

  it('return only identifiers: the API key lookup never returns secrets', async () => {
    const [def]: Array<{ result: string }> = await owner.query(
      `SELECT pg_get_function_result('public.auth_tenant(text)'::regprocedure) AS result`,
    );
    expect(def.result).toBe('uuid');
  });
});
