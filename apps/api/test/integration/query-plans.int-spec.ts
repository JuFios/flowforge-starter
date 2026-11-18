import { DataSource } from 'typeorm';
import {
  CLAIM_CANDIDATE_SQL,
  EXPIRED_LEASES_SQL,
  FINISHED_JOBS_SQL,
} from '../../src/engine/job-queue.service';
import { openTestDataSource, truncateAll } from '../helpers/db';

interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  Plans?: PlanNode[];
}

function indexesIn(node: PlanNode): string[] {
  return [
    ...(node['Index Name'] ? [node['Index Name']] : []),
    ...(node.Plans ?? []).flatMap(indexesIn),
  ];
}

function hasSeqScan(node: PlanNode): boolean {
  return (
    node['Node Type'] === 'Seq Scan' || (node.Plans ?? []).some(hasSeqScan)
  );
}

/**
 * Гарячі запити черги використовують свої індекси на реалістичному розподілі даних: більшість
 * задач давно завершені, у черзі й у роботі — небагато.
 */
describe('query plans of the queue use their indexes', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = await openTestDataSource();
    await truncateAll(ds);
    await ds.query(`
      INSERT INTO jobs ("tenantId", "executionId", status, "runAt", "lockedUntil", "finishedAt")
      SELECT gen_random_uuid(), gen_random_uuid(),
             CASE WHEN g % 400 = 0 THEN 'queued' WHEN g % 400 = 1 THEN 'running' ELSE 'done' END,
             now() - (g || ' seconds')::interval,
             CASE WHEN g % 400 = 1 THEN now() + interval '30 seconds' END,
             CASE WHEN g % 400 > 1 THEN now() - (g || ' minutes')::interval END
        FROM generate_series(1, 20000) g`);
    await ds.query(`
      INSERT INTO step_runs ("executionId", "stepIndex", "stepId", status)
      SELECT gen_random_uuid(), 0, 'call', 'succeeded' FROM generate_series(1, 20000)`);
    await ds.query(`ANALYZE jobs`);
    await ds.query(`ANALYZE step_runs`);
  });

  afterAll(async () => {
    await truncateAll(ds);
    await ds.destroy();
  });

  async function plan(sql: string, params: unknown[] = []): Promise<PlanNode> {
    const [row]: Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }> =
      await ds.query(`EXPLAIN (FORMAT JSON) ${sql}`, params);
    return row['QUERY PLAN'][0].Plan;
  }

  it.each([
    ['claiming the next ready job', CLAIM_CANDIDATE_SQL, [], 'IDX_jobs_claim'],
    ['finding expired leases', EXPIRED_LEASES_SQL, [], 'IDX_jobs_lease'],
    [
      'finding finished jobs past their retention period',
      FINISHED_JOBS_SQL,
      [7],
      'IDX_jobs_finished',
    ],
    [
      'looking a step up by its idempotency key',
      `SELECT * FROM step_runs WHERE "idempotencyKey" = $1`,
      ['00000000-0000-4000-8000-000000000000'],
      'UQ_step_runs_idempotency_key',
    ],
    [
      'loading the checkpoints of an execution',
      `SELECT * FROM step_runs WHERE "executionId" = $1 ORDER BY "stepIndex"`,
      ['00000000-0000-4000-8000-000000000000'],
      'UQ_step_runs_execution_step',
    ],
  ])('%s', async (_case, sql, params, index) => {
    const root = await plan(sql, params);
    expect(indexesIn(root)).toContain(index);
    expect(hasSeqScan(root)).toBe(false);
  });
});
