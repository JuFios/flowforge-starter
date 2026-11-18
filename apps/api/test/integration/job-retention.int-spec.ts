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

/** Більше за розмір однієї пачки видалення (1000): видалення має пройти кілька пачок. */
const OLD_BULK = 2_500;

describe('finished jobs are deleted after the retention period', () => {
  let ds: DataSource;
  let q: typeof QueueHelpers;
  let worker: RunningApp | undefined;
  const saved = {
    JOB_RETENTION_DAYS: process.env.JOB_RETENTION_DAYS,
    JOB_CLEANUP_INTERVAL_MS: process.env.JOB_CLEANUP_INTERVAL_MS,
  };

  beforeAll(async () => {
    // Оточення читається під час імпорту модуля застосунку, тож імпорт — після налаштування.
    process.env.JOB_RETENTION_DAYS = '30';
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

  it('removes done, failed and dead jobs finished long ago, in batches, and keeps the rest', async () => {
    await truncateAll(ds);
    const { tenant } = await createTenant(ds);
    const wf = await createWorkflow(ds, tenant.id);
    const execution = async (status: Execution['status']) =>
      (await createExecution(ds, wf, { status })).id;

    /** Задача зі станом і моментом завершення `finishedDaysAgo` днів тому (null — не завершена). */
    const job = async (
      status: Job['status'],
      finishedDaysAgo: number | null,
      executionId: string,
    ): Promise<string> => {
      // Незавершені — такі, яких воркер у тесті не чіпатиме: у черзі на завтра (як пауза
      // delay) або в роботі з чинним lease іншого воркера.
      const [row]: Array<{ id: string }> = await ds.query(
        `INSERT INTO jobs ("tenantId", "executionId", status, "createdAt", "finishedAt",
                           "runAt", "lockedBy", "lockedUntil", "lockToken")
         VALUES ($1, $2, $3::varchar, now() - interval '40 days',
                 now() - make_interval(days => $4::int),
                 now() + interval '1 day',
                 CASE WHEN $3::varchar = 'running' THEN 'other-worker' END,
                 CASE WHEN $3::varchar = 'running' THEN now() + interval '1 hour' END,
                 CASE WHEN $3::varchar = 'running' THEN gen_random_uuid() END)
         RETURNING id`,
        [tenant.id, executionId, status, finishedDaysAgo],
      );
      return row.id;
    };

    const oldDone = await execution('succeeded');
    await ds.query(
      `INSERT INTO step_runs ("executionId", "stepIndex", "stepId", status) VALUES ($1, 0, 'say', 'succeeded')`,
      [oldDone],
    );
    const expired = [
      await job('done', 31, oldDone),
      await job('failed', 31, await execution('failed')),
      await job('dead', 31, await execution('failed')),
    ];
    const kept = [
      await job('done', 29, await execution('succeeded')),
      // Незавершені задачі (навіть давно створені) не чіпаються.
      await job('queued', null, await execution('running')),
      await job('running', null, await execution('running')),
    ];
    await ds.query(
      `INSERT INTO jobs ("tenantId", "executionId", status, "createdAt", "finishedAt")
       SELECT $1, gen_random_uuid(), 'done', now() - interval '60 days', now() - interval '45 days'
         FROM generate_series(1, ${OLD_BULK})`,
      [tenant.id],
    );

    const { startApp } = await import('../helpers/app');
    const { WorkerModule } = await import('../../src/app.module');
    const { JobRunnerService } =
      await import('../../src/engine/job-runner.service');
    worker = await startApp(WorkerModule, { captureLogs: true });
    worker.app.get(JobRunnerService).start(1);
    await q.waitFor(
      'old finished jobs to be deleted',
      async () => (await ds.getRepository(Job).count()) === kept.length,
      { timeoutMs: 20_000, intervalMs: 200 },
    );

    const remaining = (await ds.getRepository(Job).find()).map((j) => j.id);
    expect(remaining.sort()).toEqual([...kept].sort());
    expect(remaining).not.toEqual(expect.arrayContaining(expired));
    // Один прохід очищення видалив усе, пачка за пачкою (більше за одну пачку).
    const passes = worker.logs.filter(
      (l) => l.msg === 'deleted finished jobs past their retention period',
    );
    expect(passes).toHaveLength(1);
    expect(passes[0]).toMatchObject({ deleted: OLD_BULK + expired.length });
    const metrics = await (await fetch(`${worker.baseUrl}/metrics`)).text();
    expect(metrics).toContain(
      `flowforge_jobs_purged_total ${OLD_BULK + expired.length}`,
    );
    // Історія тенанта лишається: виконання та їхні кроки не видаляються.
    expect(await ds.getRepository(Execution).count()).toBe(6);
    expect(
      await ds.getRepository(StepRun).countBy({ executionId: oldDone }),
    ).toBe(1);
  });
});
