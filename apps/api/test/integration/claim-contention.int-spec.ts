import { DataSource } from 'typeorm';
import { WorkerModule } from '../../src/app.module';
import { JobQueueService } from '../../src/engine/job-queue.service';
import { QueueMetrics } from '../../src/engine/queue.metrics';
import { RunningApp, startApp } from '../helpers/app';
import {
  createTenant,
  createWorkflow,
  openTestDataSource,
  truncateAll,
} from '../helpers/db';
import { sleep } from '../helpers/queue';

/**
 * Захоплення, коли рядок обліку тенанта тримають ненормально довго (lock_timeout) або облік
 * розійшовся із задачами (самовідновлення): воркер не зависає й не падає, а обслуговує інших.
 */
describe('claiming under contention on the usage row', () => {
  let owner: DataSource;
  let worker: RunningApp;
  let queue: JobQueueService;
  let metrics: QueueMetrics;

  beforeAll(async () => {
    owner = await openTestDataSource();
    worker = await startApp(WorkerModule);
    queue = worker.app.get(JobQueueService);
    metrics = worker.app.get(QueueMetrics);
  });

  beforeEach(async () => {
    await truncateAll(owner);
    metrics.claimContention.reset();
  });

  afterAll(async () => {
    await worker.close();
    await truncateAll(owner);
    await owner.destroy();
  });

  async function contention(reason: string): Promise<number> {
    const { values } = await metrics.claimContention.get();
    return values.find((v) => v.labels.reason === reason)?.value ?? 0;
  }

  /** Тенант із `jobs` готовими задачами, що настали `ageSeconds` тому. */
  async function tenantWithJobs(
    name: string,
    jobs: number,
    ageSeconds: number,
  ): Promise<string> {
    const { tenant } = await createTenant(owner, name);
    const wf = await createWorkflow(owner, tenant.id, name);
    await owner.query(
      `WITH v AS (SELECT id FROM workflow_versions WHERE "workflowId" = $2),
            e AS (INSERT INTO executions ("tenantId", "workflowId", "workflowVersionId")
                  SELECT $1, $2, v.id FROM generate_series(1, $3) g, v RETURNING id)
       INSERT INTO jobs ("tenantId", "executionId", "runAt")
       SELECT $1, e.id, now() - make_interval(secs => $4) FROM e`,
      [tenant.id, wf.id, jobs, ageSeconds],
    );
    return tenant.id;
  }

  it('serves another tenant when the row of the best candidate stays locked past lock_timeout, then returns to it', async () => {
    const b = await tenantWithJobs('b', 3, 100);
    const a = await tenantWithJobs('a', 3, 50);
    // Довга транзакція тримає рядок B (найкращий кандидат) 3 с — довше за lock_timeout (2 с).
    const runner = owner.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    await runner.query(
      `SELECT 1 FROM tenant_usage WHERE "tenantId" = $1 FOR UPDATE`,
      [b],
    );
    const held = (async () => {
      try {
        await sleep(3_000);
        await runner.commitTransaction();
      } finally {
        await runner.release();
      }
    })();
    const started = performance.now();
    const job = await queue.claimNext('contention');
    const waited = performance.now() - started;
    await held;
    // Не помилка захоплення і не 10 очікувань по 2 с: одне очікування, далі — інший тенант.
    expect(job!.tenantId).toBe(a);
    expect(waited).toBeGreaterThanOrEqual(1_900);
    expect(waited).toBeLessThan(2_900);
    expect(await contention('lock_timeout')).toBe(1);
    // Рядок звільнено: B знову кандидат (менше обслуговувань за A).
    expect((await queue.claimNext('contention'))!.tenantId).toBe(b);
  });

  it('repairs usage that claims ready jobs which do not exist, and claims the next tenant', async () => {
    const real = await tenantWithJobs('real', 1, 10);
    const { tenant: broken } = await createTenant(owner, 'broken');
    // Облік «бачить» три готові задачі, яких немає (за інваріантами не трапляється).
    await owner.query(
      `UPDATE tenant_usage
          SET queued = 3, "nextRunAt" = now() - interval '1 hour', ready = true,
              "lastClaimedAt" = '2000-01-01'
        WHERE "tenantId" = $1`,
      [broken.id],
    );
    const job = await queue.claimNext('repair');
    expect(job!.tenantId).toBe(real);
    expect(await contention('repair')).toBe(1);
    const [row]: Array<{
      queued: number;
      running: number;
      nextRunAt: Date | null;
      ready: boolean;
    }> = await owner.query(
      `SELECT queued, running, "nextRunAt", ready FROM tenant_usage WHERE "tenantId" = $1`,
      [broken.id],
    );
    expect(row).toEqual({
      queued: 0,
      running: 0,
      nextRunAt: null,
      ready: false,
    });
    expect(await queue.claimNext('repair')).toBeNull();
  });
});
