import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { AppModule, WorkerModule } from '../../src/app.module';
import { DB_POOL_HEADROOM } from '../../src/config/env.validation';
import { buildDataSourceOptions } from '../../src/database/database.options';
import { JobQueueService } from '../../src/engine/job-queue.service';
import { SystemDb } from '../../src/tenancy/system-db';
import { TenantDb } from '../../src/tenancy/tenant-db';
import { Execution } from '../../src/entities';
import { RunningApp, startApp } from '../helpers/app';
import {
  createTenant,
  createWorkflow,
  openTestDataSource,
  truncateAll,
} from '../helpers/db';
import { api, Receiver, sleep, startWorker, waitFor } from '../helpers/queue';
import { testDatabaseEnv, testWorkerDatabaseUrl } from '../helpers/test-env';

/**
 * Ліміт одночасних виконань тенанта (ТЗ 3.3.4): задач у стані `running` не більше за
 * `maxRunning` — жорстко, під конкуренцією захоплень. Пауза `delay` місця не займає (задача
 * чекає в черзі). Зниження ліміту не перериває задачі в роботі, а діє на нові захоплення.
 */
describe('tenant concurrent executions limit', () => {
  let owner: DataSource;
  let worker: RunningApp;
  let queue: JobQueueService;
  const receiver = new Receiver();

  beforeAll(async () => {
    owner = await openTestDataSource();
    worker = await startApp(WorkerModule);
    queue = worker.app.get(JobQueueService);
    await receiver.start();
  });

  beforeEach(() => truncateAll(owner));

  afterAll(async () => {
    await worker.close();
    await receiver.stop();
    await truncateAll(owner);
    await owner.destroy();
  });

  /** Тенант із лімітом `maxRunning` і `jobs` готовими задачами. */
  async function tenantWithJobs(
    maxRunning: number,
    jobs: number,
  ): Promise<string> {
    const { tenant } = await createTenant(owner);
    await owner.query(
      `UPDATE tenants SET "maxConcurrentExecutions" = $2 WHERE id = $1`,
      [tenant.id, maxRunning],
    );
    const wf = await createWorkflow(owner, tenant.id);
    await owner.query(
      `WITH v AS (SELECT id FROM workflow_versions WHERE "workflowId" = $2),
            e AS (INSERT INTO executions ("tenantId", "workflowId", "workflowVersionId")
                  SELECT $1, $2, v.id FROM generate_series(1, $3) g, v RETURNING id)
       INSERT INTO jobs ("tenantId", "executionId", "runAt")
       SELECT $1, e.id, now() - interval '1 second' FROM e`,
      [tenant.id, wf.id, jobs],
    );
    return tenant.id;
  }

  /**
   * Прогрів: `size` з'єднань пулу встановлено й зайнято одночасно. Чекає на **кожну** спробу:
   * Promise.all відхилився б на першій відмові (напр., `too many clients`), поки решта ще
   * підключаються, і ці з'єднання з'явилися б уже після `pool.destroy()` — сесії лишалися б у БД,
   * а Jest не завершувався. Успішні з'єднання повертаються в пул, назовні — перша помилка БД.
   */
  async function warmUp(pool: DataSource, size: number): Promise<void> {
    const runners = Array.from({ length: size }, () =>
      pool.createQueryRunner(),
    );
    const attempts = await Promise.allSettled(runners.map((r) => r.connect()));
    await Promise.all(
      runners.map((runner, i) =>
        attempts[i].status === 'fulfilled' ? runner.release() : undefined,
      ),
    );
    const failure = attempts.find(
      (a): a is PromiseRejectedResult => a.status === 'rejected',
    );
    if (failure) throw failure.reason;
  }

  async function running(tenantId: string): Promise<number> {
    const [row]: Array<{ n: number }> = await owner.query(
      `SELECT count(*)::int AS n FROM jobs WHERE "tenantId" = $1 AND status = 'running'`,
      [tenantId],
    );
    return row.n;
  }

  it('claims exactly the limit with 50 concurrent claim loops', async () => {
    const loops = 50;
    // Тест перевіряє ліміт під конкуренцією захоплень, а не швидкість, з якою сервер приймає
    // з'єднання. На спільному пулі воркера (10) 50 циклів чекали в черзі до пулу й відкривали
    // з'єднання посеред змагання; під навантаженням повного прогону це перевищувало
    // DB_CONNECT_TIMEOUT_MS (5 с) — "timeout exceeded when trying to connect". Тепер кожен цикл
    // має власне з'єднання, як у розгортанні (DB_POOL_SIZE ≥ паралельність + DB_POOL_HEADROOM),
    // і всі вони відкриті до початку змагання з найбільшим допустимим таймаутом підключення.
    const size = loops + DB_POOL_HEADROOM;
    const pool = await new DataSource(
      buildDataSourceOptions(
        {
          ...testDatabaseEnv(),
          DATABASE_URL: testWorkerDatabaseUrl(),
          DB_CONNECT_TIMEOUT_MS: 60_000,
        },
        { poolSize: size },
      ),
    ).initialize();
    try {
      await warmUp(pool, size);
      const claimQueue = new JobQueueService(
        worker.app.get(TenantDb),
        new SystemDb(pool),
        worker.app.get(ConfigService),
      );
      const t = await tenantWithJobs(3, 100);
      // Як цикли воркера: зайняті кандидати (undefined) — нова спроба, порожня черга (null) — кінець.
      const claimed = await Promise.all(
        Array.from({ length: loops }, async (_, i) => {
          let mine = 0;
          for (;;) {
            const job = await claimQueue.claimNext(`c-${i}`);
            if (job === null) return mine;
            if (job) mine++;
            else await sleep(5);
          }
        }),
      );
      expect(claimed.reduce((a, b) => a + b, 0)).toBe(3);
      expect(await running(t)).toBe(3);
    } finally {
      await pool.destroy();
    }
    // Прогрів 54 з'єднань на перевантаженому сервері займає час: межа тесту — не таймаут підключення.
  }, 120_000);

  it('never runs more jobs of a tenant than its limit under two workers, while another tenant uses the free slots', async () => {
    receiver.respond = async (_req, res) => {
      await sleep(150);
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    };
    const apiApp = await startApp(AppModule);
    const workers = [await startWorker(4), await startWorker(4)];
    try {
      const tenants = await Promise.all(
        [2, 1000].map(async (limit) => {
          const { tenant, apiKey } = await createTenant(owner);
          await owner.query(
            `UPDATE tenants SET "maxConcurrentExecutions" = $2 WHERE id = $1`,
            [tenant.id, limit],
          );
          const wf = await api<{ id: string }>(
            apiApp.baseUrl,
            apiKey,
            'POST',
            '/workflows',
            {
              name: 'slow',
              steps: [{ id: 'call', type: 'http', url: receiver.url('/slow') }],
            },
          );
          for (let i = 0; i < 12; i++)
            await api(
              apiApp.baseUrl,
              apiKey,
              'POST',
              `/workflows/${wf.body.id}/run`,
              { i },
            );
          return tenant.id;
        }),
      );
      const [limited, free] = tenants;
      const samples: Array<{ limited: number; free: number }> = [];
      await waitFor(
        'every run to succeed',
        async () => {
          samples.push({
            limited: await running(limited),
            free: await running(free),
          });
          return (
            (await owner
              .getRepository(Execution)
              .countBy({ status: 'succeeded' })) === 24
          );
        },
        { timeoutMs: 30_000, intervalMs: 20 },
      );
      expect(Math.max(...samples.map((s) => s.limited))).toBe(2);
      // Решта слотів (8) не простоює: інший тенант займає більше за ліміт першого.
      expect(Math.max(...samples.map((s) => s.free))).toBeGreaterThan(2);
    } finally {
      for (const w of workers) await w.close();
      await apiApp.close();
    }
  });

  it('does not count a run parked on a delay against the limit', async () => {
    const apiApp = await startApp(AppModule);
    const w = await startWorker(2);
    try {
      const { tenant, apiKey } = await createTenant(owner);
      await owner.query(
        `UPDATE tenants SET "maxConcurrentExecutions" = 1 WHERE id = $1`,
        [tenant.id],
      );
      const call = <T>(method: string, path: string, body?: unknown) =>
        api<T>(apiApp.baseUrl, apiKey, method, path, body);
      const parked = await call<{ id: string }>('POST', '/workflows', {
        name: 'parked',
        steps: [{ id: 'pause', type: 'delay', ms: 3_600_000 }],
      });
      const quick = await call<{ id: string }>('POST', '/workflows', {
        name: 'quick',
        steps: [{ id: 'say', type: 'log', message: 'hi' }],
      });
      const p = await call<{ id: string }>(
        'POST',
        `/workflows/${parked.body.id}/run`,
        {},
      );
      await waitFor(
        'the run to park on its delay',
        async () =>
          (await running(tenant.id)) === 0 &&
          (
            await owner.query<unknown[]>(
              `SELECT 1 FROM step_runs WHERE "executionId" = $1 AND status = 'running'`,
              [p.body.id],
            )
          ).length === 1,
      );
      const q = await call<{ id: string }>(
        'POST',
        `/workflows/${quick.body.id}/run`,
        {},
      );
      await waitFor(
        'the other run to succeed while the first one waits',
        async () =>
          (
            await owner
              .getRepository(Execution)
              .findOneByOrFail({ id: q.body.id })
          ).status === 'succeeded',
      );
    } finally {
      await w.close();
      await apiApp.close();
    }
  });

  it('keeps running jobs when the limit is lowered and claims again only below the new limit', async () => {
    const t = await tenantWithJobs(3, 10);
    const jobs = [];
    for (let i = 0; i < 3; i++) jobs.push((await queue.claimNext(`l-${i}`))!);
    await owner.query(
      `UPDATE tenants SET "maxConcurrentExecutions" = 1 WHERE id = $1`,
      [t],
    );
    expect(await running(t)).toBe(3);
    const done = (id: string) =>
      owner.query(
        `UPDATE jobs SET status = 'done', "finishedAt" = now(), "lockToken" = NULL WHERE id = $1`,
        [id],
      );
    await done(jobs[0].id);
    await done(jobs[1].id);
    // Одна задача ще в роботі — рівно ліміт: нового захоплення немає.
    expect(await queue.claimNext('l-wait')).toBeNull();
    await done(jobs[2].id);
    expect((await queue.claimNext('l-next'))!.tenantId).toBe(t);
    expect(await running(t)).toBe(1);
  });
});
