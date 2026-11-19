import { DataSource } from 'typeorm';
import { AppModule, WorkerModule } from '../../src/app.module';
import { JobQueueService } from '../../src/engine/job-queue.service';
import { Execution } from '../../src/entities';
import { RunningApp, startApp } from '../helpers/app';
import {
  createTenant,
  createWorkflow,
  openTestDataSource,
  truncateAll,
} from '../helpers/db';
import { api, startWorker, waitFor } from '../helpers/queue';

/**
 * Справедливе захоплення (ТЗ 3.3.5): тенант із глибокою чергою не відсуває інших. Поки готовий
 * тенант без задач у роботі чекає, кожен інший обслуговується не більше одного разу — незалежно
 * від глибини його черги (README, 3.3.5).
 */
describe('fair claiming between tenants', () => {
  let owner: DataSource;
  let worker: RunningApp;
  let queue: JobQueueService;

  beforeAll(async () => {
    owner = await openTestDataSource();
    // Без циклів обробки: захоплення викликаються напряму, по одному (один слот).
    worker = await startApp(WorkerModule);
    queue = worker.app.get(JobQueueService);
  });

  beforeEach(() => truncateAll(owner));

  afterAll(async () => {
    await worker.close();
    await truncateAll(owner);
    await owner.destroy();
  });

  /**
   * Тенант із `jobs` готовими задачами; найстаріша готова — `ageSeconds` тому, решта — новіші на
   * секунду кожна (через одне виконання на задачу, як після запуску через API).
   */
  async function backlog(
    name: string,
    jobs: number,
    ageSeconds: number,
  ): Promise<string> {
    const { tenant } = await createTenant(owner, name);
    const wf = await createWorkflow(owner, tenant.id, name);
    await owner.query(
      `WITH v AS (SELECT id FROM workflow_versions WHERE "workflowId" = $2),
            e AS (
              INSERT INTO executions ("tenantId", "workflowId", "workflowVersionId")
              SELECT $1, $2, v.id FROM generate_series(1, $3) g, v
              RETURNING id)
       INSERT INTO jobs ("tenantId", "executionId", "runAt")
       SELECT $1, e.id, now() - make_interval(secs => $4) + make_interval(secs => row_number() OVER ())
         FROM e`,
      [tenant.id, wf.id, jobs, ageSeconds],
    );
    return tenant.id;
  }

  /** Одне захоплення з одним слотом: задача захоплюється й одразу завершується. */
  async function claimAndFinish(): Promise<string> {
    const job = await queue.claimNext('fair-test');
    if (!job) throw new Error('nothing to claim');
    await owner.query(
      `UPDATE jobs SET status = 'done', "finishedAt" = now(), "lockToken" = NULL WHERE id = $1`,
      [job.id],
    );
    return job.tenantId;
  }

  it('alternates a lone ready tenant with a tenant holding 2000 older jobs, one slot, real completions', async () => {
    const a = await backlog('a', 2000, 10_000);
    const b = await backlog('b', 20, 60);
    const order: string[] = [];
    for (let i = 0; i < 10; i++) order.push(await claimAndFinish());
    expect(order).toEqual([a, b, a, b, a, b, a, b, a, b]);
  });

  it('claims each of 50 ready tenants once before any of them twice, one slot', async () => {
    const tenants: string[] = [];
    for (let i = 0; i < 50; i++)
      tenants.push(await backlog(`t${i}`, i === 0 ? 500 : 3, 1_000 - i));
    const first50: string[] = [];
    for (let i = 0; i < 50; i++) first50.push(await claimAndFinish());
    expect(new Set(first50).size).toBe(50);
  });

  it('lets tenant B finish while most of the backlog of tenant A still waits (several workers)', async () => {
    const api_ = await startApp(AppModule);
    const workers = [await startWorker(2), await startWorker(2)];
    try {
      const a = await backlog('a', 3000, 10_000);
      const { apiKey } = await createTenant(owner, 'b');
      const wf = await api<{ id: string }>(
        api_.baseUrl,
        apiKey,
        'POST',
        '/workflows',
        {
          name: 'b',
          steps: [{ id: 'say', type: 'log', message: 'b' }],
        },
      );
      const runs: string[] = [];
      for (let i = 0; i < 5; i++)
        runs.push(
          (
            await api<{ id: string }>(
              api_.baseUrl,
              apiKey,
              'POST',
              `/workflows/${wf.body.id}/run`,
              {},
            )
          ).body.id,
        );
      await waitFor(
        'tenant B to finish',
        async () =>
          (
            await owner
              .getRepository(Execution)
              .findBy(runs.map((id) => ({ id })))
          ).every((e) => e.status === 'succeeded'),
        { timeoutMs: 20_000 },
      );
      const [{ left }]: Array<{ left: number }> = await owner.query(
        `SELECT count(*)::int AS left FROM jobs WHERE "tenantId" = $1 AND status = 'queued'`,
        [a],
      );
      expect(left).toBeGreaterThan(2700);
    } finally {
      for (const w of workers) await w.close();
      await api_.close();
    }
  });
});
