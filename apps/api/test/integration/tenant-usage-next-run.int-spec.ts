import { DataSource } from 'typeorm';
import {
  createTenant,
  createWorkflow,
  openTestDataSource,
  truncateAll,
} from '../helpers/db';

/**
 * Після захоплення найранішої задачі тригер обліку шукає новий найближчий `runAt` тенанта. Пошук
 * мусить читати одиниці індексних записів, а не всю чергу, і тоді, коли статистика таблиці застаріла:
 * у тенанта щойно з'явився великий backlog, а останній ANALYZE його ще не бачив (тенанта немає в
 * статистиці, і планувальник оцінює його чергу в один рядок).
 */
describe('next run lookup of the tenant usage trigger', () => {
  let owner: DataSource;

  beforeAll(async () => {
    owner = await openTestDataSource();
  });

  afterAll(async () => {
    await owner.query('ALTER TABLE jobs RESET (autovacuum_enabled)');
    await truncateAll(owner);
    await owner.destroy();
  });

  /** `count` задач тенанта в черзі, усі вже готові, з різними `runAt`. */
  async function backlog(name: string, count: number): Promise<string> {
    const { tenant } = await createTenant(owner, name);
    const wf = await createWorkflow(owner, tenant.id, name);
    await owner.query(
      `WITH v AS (SELECT id FROM workflow_versions WHERE "workflowId" = $2),
            e AS (INSERT INTO executions ("tenantId", "workflowId", "workflowVersionId")
                  SELECT $1, $2, v.id FROM generate_series(1, $3) g, v RETURNING id)
       INSERT INTO jobs ("tenantId", "executionId", "runAt")
       SELECT $1, e.id, now() - interval '1 hour' + row_number() OVER () * interval '1 millisecond'
         FROM e`,
      [tenant.id, wf.id, count],
    );
    return tenant.id;
  }

  it('reads a handful of index entries after a claim even with stale statistics', async () => {
    await truncateAll(owner);
    // Статистика бачить лише іншого тенанта; autovacuum не встигає її оновити.
    await owner.query('ALTER TABLE jobs SET (autovacuum_enabled = off)');
    const seed = await backlog('seed', 500);
    await owner.query('ANALYZE jobs');
    await owner.query(`DELETE FROM jobs WHERE "tenantId" = $1`, [seed]);
    const busy = await backlog('busy', 20_000);

    // Свіже з'єднання: план тригера будується вже на застарілій статистиці.
    const fresh = await openTestDataSource();
    try {
      await fresh.transaction(async (em) => {
        const reads = async (): Promise<number> => {
          // Карта видимості свіжої таблиці порожня (autovacuum вимкнено), тож кожен прочитаний
          // індексний запис іде в купу й рахується в idx_tup_fetch.
          const [row]: Array<{ n: number }> = await em.query(
            `SELECT (idx_tup_fetch + seq_tup_read)::int AS n
               FROM pg_stat_xact_user_tables WHERE relid = 'jobs'::regclass`,
          );
          return row.n;
        };
        const before = await reads();
        const [claimed]: Array<{ tenantId: string }> = await em.query(
          `SELECT (r.job)."tenantId" FROM claim_job('next-run', 30000) r`,
        );
        expect(claimed.tenantId).toBe(busy);
        expect((await reads()) - before).toBeLessThan(100);
      });
    } finally {
      await fresh.destroy();
    }
    const [{ next, earliest }]: Array<{ next: Date; earliest: Date }> =
      await owner.query(
        `SELECT u."nextRunAt" AS next,
                (SELECT min("runAt") FROM jobs WHERE "tenantId" = $1 AND status = 'queued') AS earliest
           FROM tenant_usage u WHERE u."tenantId" = $1`,
        [busy],
      );
    expect(next).toEqual(earliest);
  }, 120_000);
});
