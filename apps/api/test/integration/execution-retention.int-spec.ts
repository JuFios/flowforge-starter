import { DataSource } from 'typeorm';
import { Execution, Job, StepRun } from '../../src/entities';
import type { RunningApp } from '../helpers/app';
import {
  createExecution,
  createTenant,
  createWorkflow,
  openTestDataSource,
  truncateAll,
} from '../helpers/db';
// Лише тип: модуль хелперів імпортує застосунок, а його конфігурація читається під час імпорту.
import type * as QueueHelpers from '../helpers/queue';

/** Більше за пачку очищення історії (500). */
const OLD_BULK = 1_200;

describe('execution history is deleted after EXECUTION_RETENTION_DAYS when enabled', () => {
  let ds: DataSource;
  let q: typeof QueueHelpers;
  let worker: RunningApp | undefined;
  const saved = {
    EXECUTION_RETENTION_DAYS: process.env.EXECUTION_RETENTION_DAYS,
    JOB_CLEANUP_INTERVAL_MS: process.env.JOB_CLEANUP_INTERVAL_MS,
  };

  beforeAll(async () => {
    // Оточення читається під час імпорту модуля застосунку, тож імпорт — після налаштування.
    process.env.EXECUTION_RETENTION_DAYS = '60';
    process.env.JOB_CLEANUP_INTERVAL_MS = '1000';
    q = await import('../helpers/queue');
    ds = await openTestDataSource();
  });

  afterEach(async () => {
    await worker?.close();
    worker = undefined;
  });

  afterAll(async () => {
    await ds.destroy();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('removes finished executions with their steps and jobs, in batches, and keeps the rest', async () => {
    await truncateAll(ds);
    const { tenant } = await createTenant(ds);
    const wf = await createWorkflow(ds, tenant.id);

    /** Виконання, завершене `daysAgo` днів тому (null — ще не завершене), з кроком і задачею. */
    const history = async (
      status: Execution['status'],
      daysAgo: number | null,
    ): Promise<string> => {
      const { id } = await createExecution(ds, wf, { status });
      await ds.query(
        `UPDATE executions SET "createdAt" = now() - interval '100 days',
                "finishedAt" = now() - make_interval(days => $2::int) WHERE id = $1`,
        [id, daysAgo],
      );
      await ds.query(
        `INSERT INTO step_runs ("executionId", "tenantId", "stepIndex", "stepId", status)
         SELECT id, "tenantId", 0, 'say', $2 FROM executions WHERE id = $1`,
        [id, status === 'failed' ? 'failed' : 'succeeded'],
      );
      // Незавершене виконання має задачу в черзі (на завтра, щоб воркер її не взяв).
      await ds.query(
        `INSERT INTO jobs ("tenantId", "executionId", status, "runAt", "finishedAt")
         VALUES ($1, $2, $3::varchar, now() + interval '1 day',
                 CASE WHEN $3::varchar = 'queued' THEN NULL ELSE now() END)`,
        [
          tenant.id,
          id,
          daysAgo === null ? 'queued' : status === 'failed' ? 'dead' : 'done',
        ],
      );
      return id;
    };

    const expired = [
      await history('succeeded', 61),
      await history('failed', 61),
    ];
    const kept = [
      await history('succeeded', 59),
      await history('running', null),
    ];
    await ds.query(
      `INSERT INTO executions ("tenantId", "workflowId", "workflowVersionId", status, "finishedAt")
       SELECT $1, $2, (SELECT id FROM workflow_versions WHERE "workflowId" = $2), 'succeeded',
              now() - interval '90 days'
         FROM generate_series(1, ${OLD_BULK})`,
      [tenant.id, wf.id],
    );

    const { startApp } = await import('../helpers/app');
    const { WorkerModule } = await import('../../src/app.module');
    const { JobRunnerService } =
      await import('../../src/engine/job-runner.service');
    worker = await startApp(WorkerModule, { captureLogs: true });
    worker.app.get(JobRunnerService).start(1);
    await q.waitFor(
      'old executions to be deleted',
      async () => (await ds.getRepository(Execution).count()) === kept.length,
      { timeoutMs: 20_000, intervalMs: 200 },
    );

    const remaining = (await ds.getRepository(Execution).find()).map(
      (e) => e.id,
    );
    expect(remaining.sort()).toEqual([...kept].sort());
    // Кроки й задачі видалених виконань теж видалено; у збережених — на місці.
    const owners = async (table: 'step_runs' | 'jobs') => {
      const rows: Array<{ id: string }> = await ds.query(
        `SELECT DISTINCT "executionId" AS id FROM ${table}`,
      );
      return rows.map((r) => r.id).sort();
    };
    expect(await owners('step_runs')).toEqual([...kept].sort());
    expect(await owners('jobs')).toEqual([...kept].sort());
    expect(
      await ds.getRepository(StepRun).countBy({ executionId: expired[0] }),
    ).toBe(0);
    expect(
      await ds.getRepository(Job).countBy({ executionId: expired[1] }),
    ).toBe(0);
    // Один прохід, пачка за пачкою; лічильник у метриках воркера.
    const passes = worker.logs.filter(
      (l) =>
        l.msg === 'deleted finished executions past their retention period',
    );
    expect(passes).toHaveLength(1);
    expect(passes[0]).toMatchObject({ deleted: OLD_BULK + expired.length });
    const metrics = await (await fetch(`${worker.baseUrl}/metrics`)).text();
    expect(metrics).toContain(
      `flowforge_executions_purged_total ${OLD_BULK + expired.length}`,
    );
  });
});
