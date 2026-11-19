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
import { api, sleep, startWorker, waitFor } from '../helpers/queue';

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

  /** Задача завершується (як її завершив би воркер); момент — за годинником БД. */
  async function finish(jobId: string): Promise<Date> {
    const [[row]]: [[{ at: Date }], number] = await owner.query(
      `UPDATE jobs SET status = 'done', "finishedAt" = clock_timestamp(), "lockToken" = NULL
        WHERE id = $1 RETURNING "finishedAt" AS at`,
      [jobId],
    );
    return row.at;
  }

  /** Одне захоплення з одним слотом: задача захоплюється й одразу завершується. */
  async function claimAndFinish(): Promise<string> {
    const job = await queue.claimNext('fair-test');
    if (!job) throw new Error('nothing to claim');
    await finish(job.id);
    return job.tenantId;
  }

  /**
   * Паралельна транзакція бере рядок обліку тенанта й тримає його `ms` мілісекунд (як постановка
   * чи завершення його задачі). `released` — момент звільнення (performance.now()).
   */
  async function holdUsageRow(
    tenantId: string,
    ms: number,
  ): Promise<{ released: Promise<number> }> {
    const runner = owner.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    await runner.query(
      `SELECT 1 FROM tenant_usage WHERE "tenantId" = $1 FOR UPDATE`,
      [tenantId],
    );
    const released = (async () => {
      try {
        await sleep(ms);
        await runner.commitTransaction();
        return performance.now();
      } finally {
        await runner.release();
      }
    })();
    return { released };
  }

  async function usage(
    tenantId: string,
  ): Promise<{ ready: boolean; running: number; due: boolean }> {
    const [row]: Array<{ ready: boolean; running: number; due: boolean }> =
      await owner.query(
        `SELECT ready, running, "nextRunAt" <= clock_timestamp() AS due
           FROM tenant_usage WHERE "tenantId" = $1`,
        [tenantId],
      );
    return row;
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

  it('waits for the usage row of the best candidate instead of skipping it, and the wait does not shorten the lease', async () => {
    const a = await backlog('a', 2000, 10_000);
    const b = await backlog('b', 20, 60);
    expect(await claimAndFinish()).toBe(a);
    // Рядок B тримає коротка транзакція його тенанта: B лишається найкращим кандидатом.
    const { released } = await holdUsageRow(b, 300);
    const job = await queue.claimNext('fair-test');
    const releasedAt = await released;
    expect(job!.tenantId).toBe(b);
    // Lease — від захоплення, а не від початку транзакції чи очікування рядка.
    const [{ lockedUntil, claimedAt }]: Array<{
      lockedUntil: Date;
      claimedAt: Date;
    }> = await owner.query(
      `SELECT "lockedUntil", $2::timestamptz AS "claimedAt" FROM jobs WHERE id = $1`,
      [job!.id, job!.claimedAt],
    );
    expect(
      Math.abs(lockedUntil.getTime() - claimedAt.getTime() - 1500),
    ).toBeLessThan(50);
    expect(job!.leaseStartedAt).toBeGreaterThanOrEqual(releasedAt - 5);
  });

  it('serves a tenant whose delay matures while its usage row is locked (promotion skips it)', async () => {
    const a = await backlog('a', 2000, 10_000);
    const { tenant } = await createTenant(owner, 'b');
    const wf = await createWorkflow(owner, tenant.id, 'b');
    expect(await claimAndFinish()).toBe(a);
    // Задача B настає за 300 мс; увесь цей час і ще 300 мс після — рядок B заблоковано.
    await owner.query(
      `WITH e AS (INSERT INTO executions ("tenantId", "workflowId", "workflowVersionId")
                  SELECT $1, $2, id FROM workflow_versions WHERE "workflowId" = $2 RETURNING id)
       INSERT INTO jobs ("tenantId", "executionId", "runAt")
       SELECT $1, e.id, clock_timestamp() + interval '300 milliseconds' FROM e`,
      [tenant.id, wf.id],
    );
    const { released } = await holdUsageRow(tenant.id, 600);
    await sleep(400);
    // Задача вже настала, але B не просунутий до індексу готових.
    expect(await usage(tenant.id)).toMatchObject({ ready: false, due: true });
    const job = await queue.claimNext('fair-test');
    await released;
    expect(job!.tenantId).toBe(tenant.id);
  });

  it('claims each of 150 tenants that mature at the same moment once before any twice (more than one promotion batch)', async () => {
    await backlog('deep', 2000, 10_000);
    const tenants: string[] = [];
    for (let i = 0; i < 150; i++) {
      const { tenant } = await createTenant(owner, `m${i}`);
      tenants.push(tenant.id);
    }
    const wf = await createWorkflow(owner, tenants[0], 'm');
    // По 3 задачі на тенанта, усі настають в одну мить; версії для захоплення не потрібні.
    await owner.query(
      `WITH at AS (SELECT clock_timestamp() + interval '500 milliseconds' AS t),
            e AS (INSERT INTO executions ("tenantId", "workflowId", status, "finishedAt")
                  SELECT id, $2, 'succeeded', now() FROM unnest($1::uuid[]) id, generate_series(1, 3)
                  RETURNING id, "tenantId")
       INSERT INTO jobs ("tenantId", "executionId", "runAt") SELECT e."tenantId", e.id, at.t FROM e, at`,
      [tenants, wf.id],
    );
    await sleep(600);
    const [{ promoted }]: Array<{ promoted: number }> = await owner.query(
      `SELECT count(*)::int AS promoted FROM tenant_usage WHERE "tenantId" = ANY ($1) AND ready`,
      [tenants],
    );
    expect(promoted).toBe(0);
    const order: string[] = [];
    for (let i = 0; i < 151; i++) order.push(await claimAndFinish());
    expect(new Set(order).size).toBe(151);
  });

  it('is not slowed by saturated tenants or tenants with only future jobs', async () => {
    const r1 = await backlog('r1', 5, 100);
    const r2 = await backlog('r2', 5, 90);
    const saturated: string[] = [];
    for (let i = 0; i < 5; i++) {
      const s = await backlog(`s${i}`, 50, 10_000 + i);
      await owner.query(
        `UPDATE tenants SET "maxConcurrentExecutions" = $2 WHERE id = $1`,
        [s, 1 + i],
      );
      // Насичений: стільки задач у роботі, скільки дозволяє його ліміт.
      await owner.query(
        `UPDATE jobs SET status = 'running', "lockToken" = gen_random_uuid(),
                         "lockedUntil" = now() + interval '1 hour'
          WHERE id IN (SELECT id FROM jobs WHERE "tenantId" = $1 ORDER BY "runAt" LIMIT $2)`,
        [s, 1 + i],
      );
      saturated.push(s);
    }
    const future = await backlog('f', 50, -3_600);
    const order: string[] = [];
    for (let i = 0; i < 10; i++) order.push(await claimAndFinish());
    expect(order).toEqual([r1, r2, r1, r2, r1, r2, r1, r2, r1, r2]);
    expect(await queue.claimNext('fair-test')).toBeNull();
    for (const [i, s] of saturated.entries())
      expect((await usage(s)).running).toBe(1 + i);
    expect((await usage(future)).running).toBe(0);
  });

  it('puts a new tenant behind the tenants already in rotation', async () => {
    const a = await backlog('a', 50, 200);
    const b = await backlog('b', 50, 100);
    expect([await claimAndFinish(), await claimAndFinish()]).toEqual([a, b]);
    const c = await backlog('c', 50, 300);
    expect([
      await claimAndFinish(),
      await claimAndFinish(),
      await claimAndFinish(),
    ]).toEqual([a, b, c]);
  });

  it('claims any other tenant at most (K-1)+C times while a ready tenant without running jobs waits (journal of 4 parallel claimers)', async () => {
    const K = 8;
    const C = 4;
    for (let i = 0; i < K; i++) await backlog(`k${i}`, 200, 1_000 + i);
    const journal: Array<{
      tenant: string;
      claimedAt: number;
      finishedAt: number;
    }> = [];
    await Promise.all(
      Array.from({ length: C }, async (_, slot) => {
        while (journal.length < 400) {
          const job = await queue.claimNext(`journal-${slot}`);
          if (job === null) return;
          if (!job) continue;
          const finishedAt = await finish(job.id);
          journal.push({
            tenant: job.tenantId,
            claimedAt: new Date(job.claimedAt).getTime(),
            finishedAt: finishedAt.getTime(),
          });
        }
      }),
    );
    // Для кожного тенанта: між завершенням його задачі (далі він готовий і без задач у роботі)
    // і його наступним захопленням інших захоплено не більше (K-1)+C разів.
    const claims = [...journal].sort((x, y) => x.claimedAt - y.claimedAt);
    let windows = 0;
    for (const { tenant, finishedAt } of journal) {
      const next = claims.find(
        (c) => c.tenant === tenant && c.claimedAt > finishedAt,
      );
      if (!next) continue;
      windows++;
      const others = claims.filter(
        (c) =>
          c.tenant !== tenant &&
          c.claimedAt > finishedAt &&
          c.claimedAt < next.claimedAt,
      );
      expect(others.length).toBeLessThanOrEqual(K - 1 + C);
    }
    expect(windows).toBeGreaterThan(300);
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
