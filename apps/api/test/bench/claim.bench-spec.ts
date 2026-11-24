import { DataSource } from 'typeorm';
import type { CheckpointService } from '../../src/engine/checkpoint.service';
import type { JobQueueService } from '../../src/engine/job-queue.service';
import type { TenantDb } from '../../src/tenancy/tenant-db';
import type { RunningApp } from '../helpers/app';
import { buildDataSourceOptions } from '../../src/database/database.options';
import { openTestDataSource, truncateAll } from '../helpers/db';
import { testDatabaseEnv } from '../helpers/test-env';

/**
 * Пропускна здатність захоплення (docs/operations.md, «Бенчмарк захоплення»): справжній
 * JobQueueService у двох екземплярах воркера з окремими пулами БД по 16 паралельних циклів (32 разом), задачі без
 * роботи — захоплення й завершення, 20 000 задач на 50 тенантів, RUNS пар прогонів FIFO і справедливої черги.
 *
 * Абсолютні числа залежать від машини (раннер CI приблизно вдвічі повільніший за ноутбук), тож
 * критерій відносний: у тому самому прогоні на тій самій БД міряється й захоплення FIFO
 * попередньої версії (e2fadbf: один UPDATE … SKIP LOCKED без обліку тенантів, роль власника) з тим
 * самим навантаженням. Прогони йдуть парами FIFO і справедливої черги впритул, з чергуванням
 * порядку в парі: зміна швидкодії раннера за час тесту зачіпає обидві половини пари однаково, а
 * не всі прогони однієї версії. За медіаною відношень у парах справедливе захоплення дає
 * щонайменше MIN_THROUGHPUT_SHARE пропускної здатності FIFO, p95 — не більше MAX_P95_RATIO × p95
 * FIFO, і в кожному прогоні — не менше MIN_CLAIMS_PER_SECOND (ловить обвал на зразок черги на
 * рядку одного тенанта, docs/architecture.md, 3.3.5).
 *
 *   npm run bench:claim
 */
const TENANTS = 50;
const JOBS = 20_000;
const PROCESSES = 2;
const LOOPS_PER_PROCESS = 16;
const RUNS = 5;
const MIN_THROUGHPUT_SHARE = 0.5;
const MAX_P95_RATIO = 3;
const MIN_CLAIMS_PER_SECOND = 300;

/** Захоплення FIFO попередньої версії (e2fadbf) — база порівняння. */
const FIFO_CLAIM_SQL = `
  UPDATE jobs
     SET status = 'running', "lockedBy" = $1, "lockToken" = gen_random_uuid(),
         "lockedUntil" = now() + make_interval(secs => $2), attempts = attempts + 1
   WHERE id = (SELECT id FROM jobs
                WHERE status = 'queued' AND "runAt" <= now()
                ORDER BY "runAt" LIMIT 1 FOR UPDATE SKIP LOCKED)
   RETURNING id, "lockToken"`;

interface RunResult {
  perSecond: number;
  p50: number;
  p95: number;
  p99: number;
  busyShare: number;
}

type Completion = 'job' | 'execution';

type ClaimLoop = (
  process: number,
  loop: number,
  completion: Completion,
) => Promise<{
  durations: number[];
  busy: number;
}>;

interface Worker {
  app: RunningApp;
  queue: JobQueueService;
  db: TenantDb;
  checkpoints: CheckpointService;
}

async function startWorkers(): Promise<Worker[]> {
  Object.assign(process.env, {
    WORKER_CONCURRENCY: String(LOOPS_PER_PROCESS),
    DB_POOL_SIZE: String(LOOPS_PER_PROCESS + 8),
  });
  const workers: Worker[] = [];
  for (let i = 0; i < PROCESSES; i++)
    await jest.isolateModulesAsync(async () => {
      const { startApp } = await import('../helpers/app');
      const { WorkerModule } = await import('../../src/app.module');
      const { JobQueueService } =
        await import('../../src/engine/job-queue.service');
      const { CheckpointService } =
        await import('../../src/engine/checkpoint.service');
      const { TenantDb } = await import('../../src/tenancy/tenant-db');
      const app = await startApp(WorkerModule);
      workers.push({
        app,
        queue: app.app.get(JobQueueService),
        db: app.app.get(TenantDb),
        checkpoints: app.app.get(CheckpointService),
      });
    });
  return workers;
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

describe('claim throughput', () => {
  let owner: DataSource;
  let workers: Worker[];

  beforeAll(async () => {
    owner = await openTestDataSource();
    workers = await startWorkers();
  });

  afterAll(async () => {
    for (const w of workers) await w.app.close();
    await truncateAll(owner);
    await owner.destroy();
  });

  async function seed(completion: Completion): Promise<void> {
    await truncateAll(owner);
    await owner.query(`
      INSERT INTO tenants (name, "apiKeyHash", "webhookSecret")
      SELECT 'bench-' || g, md5('k' || g) || md5('h' || g), 's' FROM generate_series(1, ${TENANTS}) g`);
    await owner.query(`
      WITH workflows_created AS (
        INSERT INTO workflows ("tenantId", name, steps)
        SELECT id, 'bench', '[{"id":"log","type":"log","message":"done"}]'::jsonb FROM tenants
        RETURNING id, "tenantId", steps
      )
      INSERT INTO workflow_versions ("workflowId", "tenantId", version, steps)
      SELECT id, "tenantId", 1, steps FROM workflows_created`);
    await owner.query(
      `
      WITH t AS (SELECT v.*, row_number() OVER (ORDER BY v."tenantId") - 1 AS n FROM workflow_versions v)
      INSERT INTO executions ("tenantId", "workflowId", "workflowVersionId", status, "finishedAt")
      SELECT t."tenantId", t."workflowId", t.id, CASE WHEN $1 THEN 'running' ELSE 'succeeded' END,
             CASE WHEN $1 THEN NULL ELSE now() END
        FROM generate_series(1, ${JOBS}) g JOIN t ON t.n = g % ${TENANTS}`,
      [completion === 'execution'],
    );
    await owner.query(`
      INSERT INTO jobs ("tenantId", "executionId", "runAt")
      SELECT "tenantId", id, now() - interval '1 minute' FROM executions`);
    await owner.query('ANALYZE jobs');
    await owner.query('ANALYZE tenant_usage');
  }

  /** Один прогін: усі цикли разом до порожньої черги; тривалість кожного захоплення. */
  async function measure(
    loop: ClaimLoop,
    completion: Completion,
  ): Promise<RunResult> {
    await seed(completion);
    const started = performance.now();
    const parts = await Promise.all(
      Array.from({ length: PROCESSES }, (_, p) =>
        Array.from({ length: LOOPS_PER_PROCESS }, (_, l) =>
          loop(p, l, completion),
        ),
      ).flat(),
    );
    const seconds = (performance.now() - started) / 1000;
    const durations = parts.flatMap((part) => part.durations);
    const busy = parts.reduce((sum, part) => sum + part.busy, 0);
    expect(durations).toHaveLength(JOBS);
    const [terminal]: Array<{ jobs: number; executions: number }> =
      await owner.query(
        `SELECT count(*) FILTER (WHERE j.status = 'done')::int AS jobs,
              count(*) FILTER (WHERE e.status = 'succeeded' AND e.output = 'true'::jsonb)::int AS executions
         FROM jobs j JOIN executions e ON e.id = j."executionId"`,
      );
    expect(terminal.jobs).toBe(JOBS);
    if (completion === 'execution') expect(terminal.executions).toBe(JOBS);
    const sorted = [...durations].sort((a, b) => a - b);
    return {
      perSecond: Math.round(durations.length / seconds),
      p50: +percentile(sorted, 0.5).toFixed(1),
      p95: +percentile(sorted, 0.95).toFixed(1),
      p99: +percentile(sorted, 0.99).toFixed(1),
      busyShare: +(busy / (busy + durations.length)).toFixed(3),
    };
  }

  /** Справедливе захоплення воркера й завершення, як у воркера (lease і `done` в одній транзакції). */
  const fairLoop: ClaimLoop = async (p, l, completion) => {
    const w = workers[p];
    const durations: number[] = [];
    let busy = 0;
    for (;;) {
      const t0 = performance.now();
      const job = await w.queue.claimNext(`bench-${p}-${l}`);
      if (job === null) return { durations, busy };
      if (!job) {
        busy++;
        continue;
      }
      durations.push(performance.now() - t0);
      if (completion === 'execution') await w.checkpoints.finish(job, true);
      else await w.db.run(job.tenantId, (em) => w.queue.completeIn(em, job));
    }
  };

  /** Окремі пули FIFO того самого розміру, що й у воркерів. */
  function openFifoPools(): Promise<DataSource[]> {
    return Promise.all(
      Array.from({ length: PROCESSES }, () =>
        new DataSource(
          buildDataSourceOptions(testDatabaseEnv(), {
            poolSize: LOOPS_PER_PROCESS + 8,
          }),
        ).initialize(),
      ),
    );
  }

  /**
   * Один прогін FIFO попередньої версії; завершення — як тоді. Пули відкриваються на прогін і
   * закриваються після нього: з’єднань одночасно не більше, ніж за послідовного порівняння.
   */
  async function fifoRun(completion: Completion): Promise<RunResult> {
    const pools = await openFifoPools();
    const claimSql =
      completion === 'execution'
        ? FIFO_CLAIM_SQL + ', "executionId"'
        : FIFO_CLAIM_SQL;
    // Як на e2fadbf: частковий індекс черги за часом і жодних тригерів обліку тенантів.
    await owner.query(
      `CREATE INDEX "IDX_bench_fifo_claim" ON jobs ("runAt") WHERE status = 'queued'`,
    );
    await owner.query('ALTER TABLE jobs DISABLE TRIGGER USER');
    try {
      const loop: ClaimLoop = async (p, l) => {
        const ds = pools[p];
        const durations: number[] = [];
        for (;;) {
          const t0 = performance.now();
          const [rows]: [
            Array<{ id: string; lockToken: string; executionId: string }>,
            number,
          ] = await ds.query(claimSql, [`fifo-${p}-${l}`, 30]);
          if (!rows[0]) return { durations, busy: 0 };
          durations.push(performance.now() - t0);
          await ds.transaction(async (em) => {
            await em.query(
              `SELECT 1 FROM jobs WHERE id = $1 AND "lockToken" = $2 AND status = 'running' FOR UPDATE`,
              [rows[0].id, rows[0].lockToken],
            );
            await em.query(
              `UPDATE jobs SET status = 'done', "lockedBy" = NULL, "lockedUntil" = NULL,
                               "lockToken" = NULL, "finishedAt" = now()
                WHERE id = $1`,
              [rows[0].id],
            );
            if (completion === 'execution')
              await em.query(
                `UPDATE executions SET status = 'succeeded', output = $2, error = NULL, "finishedAt" = now()
                WHERE id = $1`,
                [rows[0].executionId, JSON.stringify(true)],
              );
          });
        }
      };
      return await measure(loop, completion);
    } finally {
      await owner.query('ALTER TABLE jobs ENABLE TRIGGER USER');
      await owner.query('DROP INDEX "IDX_bench_fifo_claim"');
      await truncateAll(owner);
      for (const ds of pools) await ds.destroy();
    }
  }

  const median = (values: number[]) =>
    [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

  const describeRuns = (name: string, results: RunResult[]) =>
    `  ${name}:\n` +
    results
      .map(
        (r, i) =>
          `    run ${i + 1}: ${r.perSecond} claims/s, p50 ${r.p50} ms, p95 ${r.p95} ms, p99 ${r.p99} ms, busy answers ${(r.busyShare * 100).toFixed(1)}%`,
      )
      .join('\n');

  it.each<Completion>(['job', 'execution'])(
    `%s completion keeps at least ${MIN_THROUGHPUT_SHARE * 100}% of the FIFO throughput and p95 within ${MAX_P95_RATIO}× of it (${RUNS} runs each)`,
    async (completion) => {
      const fifo: RunResult[] = [];
      const fair: RunResult[] = [];
      for (let run = 0; run < RUNS; run++) {
        // Парні прогони починає FIFO, непарні — справедлива черга.
        if (run % 2 === 0) fifo.push(await fifoRun(completion));
        fair.push(await measure(fairLoop, completion));
        if (run % 2 === 1) fifo.push(await fifoRun(completion));
      }
      const share = median(fair.map((r, i) => r.perSecond / fifo[i].perSecond));
      const p95Ratio = median(fair.map((r, i) => r.p95 / fifo[i].p95));
      console.log(
        `claim bench, ${completion} completion (${PROCESSES}×${LOOPS_PER_PROCESS} loops, ${JOBS} jobs, ${TENANTS} tenants):\n` +
          describeRuns('fair (this version)', fair) +
          '\n' +
          describeRuns('FIFO (e2fadbf)', fifo) +
          `\n  fair / FIFO, median of ${RUNS} adjacent pairs: throughput ${(share * 100).toFixed(0)}%, p95 ×${p95Ratio.toFixed(2)}`,
      );
      expect(share).toBeGreaterThanOrEqual(MIN_THROUGHPUT_SHARE);
      expect(p95Ratio).toBeLessThanOrEqual(MAX_P95_RATIO);
      for (const r of fair)
        expect(r.perSecond).toBeGreaterThanOrEqual(MIN_CLAIMS_PER_SECOND);
    },
  );
});
