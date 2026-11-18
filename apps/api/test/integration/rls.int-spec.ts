import { DataSource, EntityManager } from 'typeorm';
import { Execution, Job, StepRun, Workflow } from '../../src/entities';
import {
  createExecution,
  createTenant,
  createWorkflow,
  openTestDataSource,
  truncateAll,
} from '../helpers/db';

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
