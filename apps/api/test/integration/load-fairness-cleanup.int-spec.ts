import { DataSource } from 'typeorm';
import { withBacklog } from '../../scripts/load-fairness';
import {
  createTenant,
  createWorkflow,
  openTestDataSource,
  truncateAll,
} from '../helpers/db';

/**
 * Навантажувальний сценарій прибирає невиконаний backlog тенанта A, щоб наступний прогін почався з
 * нуля. Задача A, що чекає на повтор після тимчасової помилки http, уже має рядки `step_runs`.
 */
describe('fairness load backlog cleanup', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = await openTestDataSource();
  });
  beforeEach(() => truncateAll(ds));
  afterAll(async () => {
    await truncateAll(ds);
    await ds.destroy();
  });

  it('removes queued jobs waiting for a retry together with their steps', async () => {
    const { tenant: a } = await createTenant(ds, 'load-a');
    const wf = await createWorkflow(ds, a.id, 'load-a');
    const { tenant: other } = await createTenant(ds, 'other');
    const otherWf = await createWorkflow(ds, other.id, 'other');
    const [kept]: Array<{ id: string }> = await ds.query(
      `INSERT INTO executions ("tenantId", "workflowId", "workflowVersionId")
       SELECT $1, $2, v.id FROM workflow_versions v WHERE v."workflowId" = $2 RETURNING id`,
      [other.id, otherWf.id],
    );
    await ds.query(
      `INSERT INTO jobs ("tenantId", "executionId") VALUES ($1, $2)`,
      [other.id, kept.id],
    );

    await withBacklog(ds, { id: a.id, workflow: wf.id, auth: {} }, async () => {
      // Перша спроба кроку впала: задача знову в черзі, а крок уже записано.
      await ds.query(
        `INSERT INTO step_runs ("tenantId", "executionId", "stepIndex", "stepId", status)
           SELECT j."tenantId", j."executionId", 0, 'call', 'failed'
             FROM jobs j WHERE j."tenantId" = $1 ORDER BY j.id LIMIT 3`,
        [a.id],
      );
      await ds.query(
        `UPDATE jobs SET "runAt" = now() + interval '1 minute', attempts = 1
            WHERE "executionId" IN (SELECT "executionId" FROM step_runs WHERE "tenantId" = $1)`,
        [a.id],
      );
    });

    const count = async (table: string, tenantId: string): Promise<number> => {
      const [{ n }]: Array<{ n: number }> = await ds.query(
        `SELECT count(*)::int AS n FROM ${table} WHERE "tenantId" = $1`,
        [tenantId],
      );
      return n;
    };
    for (const table of ['jobs', 'executions', 'step_runs'])
      expect(await count(table, a.id)).toBe(0);
    expect(await count('jobs', other.id)).toBe(1);
    expect(await count('executions', other.id)).toBe(1);
    // Сценарій ставить і прибирає справжній backlog (A_JOBS задач); межа очищення — 120 с.
  }, 180_000);
});
