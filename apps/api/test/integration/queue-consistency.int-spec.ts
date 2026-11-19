import { DataSource } from 'typeorm';
import { WorkerModule } from '../../src/app.module';
import { JobQueueService } from '../../src/engine/job-queue.service';
import { JobRunnerService } from '../../src/engine/job-runner.service';
import { Execution } from '../../src/entities';
import { RunningApp, startApp } from '../helpers/app';
import { createTenant, openTestDataSource, truncateAll } from '../helpers/db';
import { api, Receiver, sleep, waitFor } from '../helpers/queue';

/**
 * Облік тенантів під змішаним конкурентним навантаженням (README, «Порядок блокувань»): два
 * воркери, постановка через API, повтори, reaper проти воркерів (lease відбирається посеред
 * кроку), очищення, примусові ROLLBACK змін задач і транзакції, що тримають рядок обліку.
 *
 * - Кожен знімок (один оператор — один знімок) показує облік, що точно дорівнює агрегатам `jobs`,
 *   а задач у роботі — не більше за ліміт тенанта; `ready` ⇒ задача вже настала.
 * - Жодного deadlock-у й жодної помилки захоплення чи обробки; усе завершується.
 */
describe('tenant usage stays exact under mixed concurrent load', () => {
  let owner: DataSource;
  let apiApp: RunningApp;
  let maintenance: RunningApp;
  const workers: RunningApp[] = [];
  const receiver = new Receiver();

  beforeAll(async () => {
    owner = await openTestDataSource();
    await truncateAll(owner);
    apiApp = await startApp();
    // Воркер без циклів обробки: reaper і очищення викликаються тестом частіше, ніж за розкладом.
    maintenance = await startApp(WorkerModule);
    await receiver.start();
  });

  afterAll(async () => {
    for (const w of workers) await w.close();
    await maintenance.close();
    await apiApp.close();
    await receiver.stop();
    await truncateAll(owner);
    await owner.destroy();
  });

  /** Розбіжності обліку з фактичними задачами — одним оператором, тобто на одному знімку. */
  async function mismatches(): Promise<unknown[]> {
    return owner.query(`
      SELECT u."tenantId", u.queued, a.queued AS "actualQueued", u.running,
             a.running AS "actualRunning", u."maxRunning", u."nextRunAt", a.next, u.ready
        FROM tenant_usage u
        LEFT JOIN (SELECT "tenantId",
                          count(*) FILTER (WHERE status = 'queued')::int AS queued,
                          count(*) FILTER (WHERE status = 'running')::int AS running,
                          min("runAt") FILTER (WHERE status = 'queued') AS next
                     FROM jobs GROUP BY "tenantId") a ON a."tenantId" = u."tenantId"
       WHERE u.queued <> COALESCE(a.queued, 0)
          OR u.running <> COALESCE(a.running, 0)
          OR u."nextRunAt" IS DISTINCT FROM a.next
          OR u.running > u."maxRunning"
          OR (u.ready AND NOT (u."nextRunAt" <= clock_timestamp()))`);
  }

  it('matches the jobs exactly in every snapshot, with no deadlock and every run finished', async () => {
    // http-крок: кожен п'ятий запит — 503 (повтор із backoff), шлях /bad — 400 (провал → /retry).
    let calls = 0;
    let badFails = true;
    receiver.respond = async (req, res) => {
      if (req.path === '/bad' && badFails) return void res.writeHead(400).end();
      // Довгий крок: задачі в роботі, у яких reaper відбирає lease.
      if (req.path === '/slow') await sleep(400);
      if (++calls % 5 === 0) return void res.writeHead(503).end();
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    };

    const tenants = await Promise.all(
      ['a', 'b', 'c'].map(async (name) => {
        const { tenant, apiKey } = await createTenant(owner, name);
        const call = <T>(method: string, path: string, body?: unknown) =>
          api<T>(apiApp.baseUrl, apiKey, method, path, body);
        const ok = await call<{ id: string }>('POST', '/workflows', {
          name: `${name}-ok`,
          steps: [
            { id: 'say', type: 'log', message: 'hi' },
            { id: 'pause', type: 'delay', ms: 30 },
            { id: 'call', type: 'http', url: receiver.url('/ok') },
          ],
        });
        const slow = await call<{ id: string }>('POST', '/workflows', {
          name: `${name}-slow`,
          steps: [{ id: 'call', type: 'http', url: receiver.url('/slow') }],
        });
        const bad = await call<{ id: string }>('POST', '/workflows', {
          name: `${name}-bad`,
          steps: [{ id: 'call', type: 'http', url: receiver.url('/bad') }],
        });
        return {
          id: tenant.id,
          call,
          ok: ok.body.id,
          slow: slow.body.id,
          bad: bad.body.id,
        };
      }),
    );
    // Тенант c — з малим лімітом задач у роботі: ліміт тримається під конкуренцією.
    await owner.query(
      `UPDATE tenants SET "maxConcurrentExecutions" = 2 WHERE id = $1`,
      [tenants[2].id],
    );

    for (let i = 0; i < 2; i++) {
      const w = await startApp(WorkerModule, { captureLogs: true });
      w.app.get(JobRunnerService).start(4);
      workers.push(w);
    }

    const errors: unknown[] = [];
    // Скільки разів кожна дія справді щось зробила: тест мусить їх перевіряти, а не пропускати.
    const done = { snapshots: 0, reaped: 0, purged: 0, retried: 0 };
    let expired = 0;
    const found: unknown[] = [];
    let stop = false;
    const chaos = (name: string, everyMs: number, fn: () => Promise<void>) =>
      (async () => {
        while (!stop) {
          try {
            await fn();
          } catch (err) {
            errors.push({ name, err: String(err) });
          }
          await sleep(everyMs);
        }
      })();

    const queue = maintenance.app.get(JobQueueService);
    const background = [
      // Знімки обліку.
      chaos('snapshot', 25, async () => {
        found.push(...(await mismatches()));
        done.snapshots++;
      }),
      // Зміни задач, що відкочуються: облік змінюється в тій самій транзакції й відкочується теж.
      chaos('rollback', 15, async () => {
        await owner
          .transaction(async (em) => {
            await em.query(
              `UPDATE jobs SET status = 'running', "runAt" = now() - interval '1 day'
                WHERE id IN (SELECT id FROM jobs WHERE status = 'queued' LIMIT 3
                                FOR UPDATE SKIP LOCKED)`,
            );
            throw new Error('rollback');
          })
          .catch((err: Error) => {
            if (err.message !== 'rollback') throw err;
          });
      }),
      // Коротка транзакція тримає рядок обліку (як постановка чи завершення в іншому процесі).
      chaos('hold', 120, async () => {
        const tenant = tenants[Math.floor(Math.random() * 3)];
        await owner.transaction(async (em) => {
          await em.query(
            `SELECT 1 FROM tenant_usage WHERE "tenantId" = $1 FOR UPDATE`,
            [tenant.id],
          );
          await sleep(150);
        });
      }),
      // Lease відбирається посеред кроку: reaper повертає задачу, воркер її кидає.
      // Обмежено (20 разів): інакше довгі кроки ніколи б не завершились.
      chaos('expire', 300, async () => {
        if (expired >= 20) return;
        expired++;
        await owner.query(
          `UPDATE jobs SET "lockedUntil" = now() - interval '1 second'
            WHERE id IN (SELECT id FROM jobs WHERE status = 'running' LIMIT 1)`,
        );
      }),
      chaos('reap', 50, async () => {
        done.reaped += (await queue.reapExpired()).length;
      }),
      chaos('purge', 200, async () => {
        // Завершені задачі «старіють» і видаляються очищенням (термін — щонайменше доба).
        await owner.query(
          `UPDATE jobs SET "finishedAt" = now() - interval '2 days'
            WHERE id IN (SELECT id FROM jobs WHERE status = 'done' LIMIT 5)`,
        );
        done.purged += await queue.purgeFinished(1);
      }),
      // Проваленні виконання — знову в чергу (паралельно з reaper-ом і воркерами).
      chaos('retry', 100, async () => {
        for (const t of tenants) {
          const failed = await owner.getRepository(Execution).findBy({
            tenantId: t.id,
            status: 'failed',
          });
          for (const e of failed.slice(0, 3)) {
            const res = await t.call('POST', `/executions/${e.id}/retry`);
            if (res.status === 202) done.retried++;
            else if (res.status !== 409) throw new Error(`retry ${res.status}`);
          }
        }
      }),
    ];

    // Постановка: по 40 запусків на тенанта паралельно, частина — в провал.
    const runs = await Promise.all(
      tenants.flatMap((t) =>
        Array.from({ length: 40 }, async (_, i) => {
          const res = await t.call<{ id: string }>(
            'POST',
            `/workflows/${i % 8 === 0 ? t.bad : i % 4 === 1 ? t.slow : t.ok}/run`,
            { i },
          );
          if (res.status !== 201) throw new Error(`run ${res.status}`);
          return res.body.id;
        }),
      ),
    );
    await sleep(3_000);
    badFails = false;

    await waitFor(
      'every run to succeed and every action to act',
      async () =>
        done.reaped > 0 &&
        done.purged > 0 &&
        done.retried > 0 &&
        (await owner
          .getRepository(Execution)
          .countBy({ status: 'succeeded' })) === runs.length,
      { timeoutMs: 60_000, intervalMs: 200 },
    );
    stop = true;
    await Promise.all(background);

    expect(errors).toEqual([]);
    expect(done.snapshots).toBeGreaterThan(50);
    expect(done.reaped).toBeGreaterThan(0);
    expect(done.purged).toBeGreaterThan(0);
    expect(done.retried).toBeGreaterThan(0);
    expect(found).toEqual([]);
    expect(await mismatches()).toEqual([]);
    const trouble = workers
      .flatMap((w) => w.logs)
      .filter((l) =>
        /deadlock|claim failed|processing failed|reaper failed/.test(
          JSON.stringify(l),
        ),
      );
    expect(trouble).toEqual([]);
  }, 120_000);
});
