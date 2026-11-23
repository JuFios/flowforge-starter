import { DataSource } from 'typeorm';
import { withBacklog } from '../../scripts/load-fairness';
import { SchedulerService } from '../../src/scheduler/scheduler.service';
import { RunningApp, startApp } from '../helpers/app';
import {
  createTenant,
  createWorkflow,
  openTestDataSource,
  truncateAll,
} from '../helpers/db';
import { Receiver } from '../helpers/queue';

/**
 * Навантажувальний сценарій прибирає невиконаний backlog тенанта A, щоб наступний прогін почався з
 * нуля. Задача A, що чекає на повтор після тимчасової помилки http, уже має рядки `step_runs`.
 */
describe('fairness load backlog cleanup', () => {
  let ds: DataSource;
  let app: RunningApp;
  const receiver = new Receiver();

  beforeAll(async () => {
    ds = await openTestDataSource();
    await receiver.start();
    app = await startApp();
    app.app.get(SchedulerService).onApplicationShutdown();
  });
  beforeEach(() => truncateAll(ds));
  afterAll(async () => {
    await app.close();
    await receiver.stop();
    await truncateAll(ds);
    await ds.destroy();
  });

  it('removes jobs awaiting a retry and clears A notifications between measurements', async () => {
    const { tenant: a, apiKey } = await createTenant(ds, 'load-a');
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
    await ds.query(
      `INSERT INTO outbox_events ("tenantId", "executionId", sequence, type, payload)
       VALUES ($1, $2, 1, 'execution.succeeded', '{}')`,
      [other.id, kept.id],
    );

    await withBacklog(
      ds,
      { id: a.id, workflow: wf.id, auth: { 'x-api-key': apiKey } },
      async () => {
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
        await ds.query(
          `INSERT INTO outbox_events ("tenantId", "executionId", sequence, type, payload, status, "leaseToken", "leaseUntil")
         VALUES ($1, gen_random_uuid(), 1, 'execution.succeeded', '{}', 'pending', NULL, NULL),
                ($1, gen_random_uuid(), 1, 'execution.succeeded', '{}', 'sending', gen_random_uuid(),
                 clock_timestamp() - interval '1 second')`,
          [a.id],
        );
      },
      { apiUrl: app.baseUrl, endpoint: receiver.url('/unavailable') },
    );

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
    expect(await count('notification_settings', a.id)).toBe(0);
    expect(
      await ds.query('SELECT status FROM outbox_events WHERE "tenantId" = $1', [
        a.id,
      ]),
    ).toEqual([{ status: 'cancelled' }, { status: 'cancelled' }]);
    expect(
      await ds.query('SELECT status FROM outbox_events WHERE "tenantId" = $1', [
        other.id,
      ]),
    ).toEqual([{ status: 'pending' }]);
    // Сценарій ставить і прибирає справжній backlog (A_JOBS задач); межа очищення — 120 с.
  }, 180_000);
});
