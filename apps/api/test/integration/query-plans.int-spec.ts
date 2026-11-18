import { DataSource } from 'typeorm';
import {
  CLAIM_CANDIDATE_SQL,
  EXPIRED_LEASES_SQL,
  FINISHED_JOBS_SQL,
  PURGE_EXECUTIONS_SQL,
  PURGE_FINISHED_SQL,
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
    // 50 тенантів; кожне з 20 тис. виконань має задачу й крок свого тенанта (композитні FK).
    await ds.query(`
      INSERT INTO tenants (name, "apiKeyHash", "webhookSecret")
      SELECT 'plan-' || g, md5('key-' || g) || md5('hash-' || g), 'secret'
        FROM generate_series(1, 50) g`);
    // Виконання: завершені, з ключем запуску в кожного десятого.
    await ds.query(`
      WITH t AS (SELECT id, row_number() OVER (ORDER BY id) - 1 AS n FROM tenants)
      INSERT INTO executions ("tenantId", "workflowId", status, "idempotencyKey", "finishedAt")
      SELECT t.id, gen_random_uuid(), 'succeeded',
             CASE WHEN g % 10 = 0 THEN 'key-' || g END,
             now() - (g || ' minutes')::interval
        FROM generate_series(1, 20000) g JOIN t ON t.n = g % 50`);
    await ds.query(`
      INSERT INTO jobs ("tenantId", "executionId", status, "runAt", "lockedUntil", "finishedAt")
      SELECT e."tenantId", e.id,
             CASE WHEN g % 400 = 0 THEN 'queued' WHEN g % 400 = 1 THEN 'running' ELSE 'done' END,
             now() - (g || ' seconds')::interval,
             CASE WHEN g % 400 = 1 THEN now() + interval '30 seconds' END,
             CASE WHEN g % 400 > 1 THEN now() - (g || ' minutes')::interval END
        FROM (SELECT id, "tenantId", row_number() OVER (ORDER BY id) AS g FROM executions) e`);
    await ds.query(`
      INSERT INTO step_runs ("executionId", "tenantId", "stepIndex", "stepId", status)
      SELECT id, "tenantId", 0, 'call', 'succeeded' FROM executions`);
    await ds.query(`ANALYZE executions`);
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
    [
      'finding expired leases of a tenant',
      EXPIRED_LEASES_SQL,
      ['00000000-0000-4000-8000-000000000000'],
      'IDX_jobs_lease',
    ],
    [
      'finding finished jobs past their retention period',
      FINISHED_JOBS_SQL,
      [7],
      'IDX_jobs_finished',
    ],
    [
      // Сам DELETE: пачка вибирається індексом очищення, а рядки видаляються за первинним
      // ключем — без читання всієї таблиці на кожну пачку.
      'deleting one batch of finished jobs',
      PURGE_FINISHED_SQL,
      [7],
      'IDX_jobs_finished',
    ],
    [
      // Пачка історії: вибір — індексом завершених виконань, видалення кроків, задач і виконань —
      // за ключами (без Seq Scan жодної з трьох таблиць).
      'deleting one batch of execution history',
      PURGE_EXECUTIONS_SQL,
      [7],
      'IDX_executions_finished',
    ],
    [
      'finding the job of an execution (retry, history cleanup)',
      `SELECT * FROM jobs WHERE "executionId" = $1`,
      ['00000000-0000-4000-8000-000000000000'],
      'IDX_jobs_execution',
    ],
    [
      'looking a run up by the Idempotency-Key of its tenant',
      `SELECT * FROM executions WHERE "tenantId" = $1 AND "idempotencyKey" = $2`,
      ['00000000-0000-4000-8000-000000000000', 'key-10'],
      'UQ_executions_idempotency_key',
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
