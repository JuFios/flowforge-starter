import { Client } from 'pg';
import { DataSource } from 'typeorm';
import type { PostgresDriver } from 'typeorm/driver/postgres/PostgresDriver';
import type { RunningApp } from '../helpers/app';
import { openTestDataSource, truncateAll } from '../helpers/db';
import { testDatabaseUrl } from '../helpers/test-env';
import { waitFor } from '../helpers/wait-for';

/**
 * Вартість кроку для БД (docs/operations.md, «Бенчмарк кроків»): справжні цикли JobRunnerService у
 * двох екземплярах воркера по 16 циклів виконують EXECUTIONS виконань по STEPS кроків `log` (без
 * HTTP, тож міряється лише робота з БД). Звітує звернень до БД і транзакцій на крок, сповіщень
 * `ff_execution` на крок, частку HOT-оновлень гарячих таблиць і пропускну здатність.
 *
 * Абсолютні числа залежать від машини, тож тут лише перевірка повноти й звіт у консоль. Детерміновані
 * межі кількості запитів на крок перевіряє інтеграційний тест `step-statements`.
 *
 *   npm run bench:claim -- steps
 */
const TENANTS = 20;
const EXECUTIONS = 2_000;
const STEPS = 10;
const PROCESSES = 2;
const LOOPS_PER_PROCESS = 16;

interface Counter {
  statements: number;
  transactions: number;
}

const COUNTED = Symbol('bench statement counter');

/**
 * Рахує звернення до БД усіх клієнтів пулу воркера: кожен виклик `query` — одне звернення.
 * Транзакція — `START TRANSACTION` або оператор поза транзакцією. Liveness-пінги й `LISTEN`
 * не рахуються: вони не залежать від кроків.
 */
function countStatements(ds: DataSource, counter: Counter): void {
  const pool = (ds.driver as PostgresDriver).master as {
    Client: { prototype: Record<string | symbol, unknown> };
  };
  const proto = pool.Client.prototype;
  if (proto[COUNTED]) return;
  proto[COUNTED] = true;
  const original = proto.query as (...args: unknown[]) => unknown;
  const inTransaction = new WeakSet<object>();
  proto.query = function (this: object, ...args: unknown[]) {
    const first = args[0] as string | { text?: string };
    const text = (typeof first === 'string' ? first : (first?.text ?? ''))
      .trim()
      .toUpperCase();
    if (!/^(SELECT 1|LISTEN|UNLISTEN)\b/.test(text)) {
      counter.statements++;
      if (text.startsWith('START TRANSACTION') || text.startsWith('BEGIN')) {
        inTransaction.add(this);
        counter.transactions++;
      } else if (/^(COMMIT|ROLLBACK)/.test(text)) {
        inTransaction.delete(this);
      } else if (!inTransaction.has(this)) {
        counter.transactions++;
      }
    }
    return original.apply(this, args);
  };
}

interface TableStats {
  relname: string;
  upd: number;
  hot: number;
}

async function tableStats(owner: DataSource): Promise<TableStats[]> {
  await owner.query('SELECT pg_stat_clear_snapshot()');
  return owner.query(
    `SELECT relname, n_tup_upd::int AS upd, n_tup_hot_upd::int AS hot
       FROM pg_stat_user_tables
      WHERE relname IN ('jobs', 'executions', 'step_runs') ORDER BY relname`,
  );
}

describe('step cost', () => {
  let owner: DataSource;
  let listener: Client;
  let notifications = 0;
  const workers: RunningApp[] = [];
  const runners: Array<{ start(n: number): void }> = [];
  const counter: Counter = { statements: 0, transactions: 0 };

  beforeAll(async () => {
    Object.assign(process.env, {
      WORKER_CONCURRENCY: String(LOOPS_PER_PROCESS),
      DB_POOL_SIZE: String(LOOPS_PER_PROCESS + 8),
      // Робочі значення: короткий lease інтеграційних тестів додав би heartbeat-и до звернень кроку.
      JOB_LEASE_MS: '30000',
      WORKER_POLL_INTERVAL_MS: '500',
    });
    owner = await openTestDataSource();
    await truncateAll(owner);
    listener = new Client({ connectionString: testDatabaseUrl() });
    await listener.connect();
    listener.on('notification', () => notifications++);
    await listener.query('LISTEN ff_execution');
  });

  afterAll(async () => {
    for (const w of workers) await w.close();
    await listener.end();
    await truncateAll(owner);
    await owner.destroy();
  });

  it(`runs ${EXECUTIONS} executions of ${STEPS} log steps and reports the database cost per step`, async () => {
    const steps = JSON.stringify(
      Array.from({ length: STEPS }, (_, i) => ({
        id: `s${i}`,
        type: 'log',
        message: 'step',
      })),
    );
    await owner.query(`
      INSERT INTO tenants (name, "apiKeyHash", "webhookSecret")
      SELECT 'bench-' || g, md5('k' || g) || md5('h' || g), 's' FROM generate_series(1, ${TENANTS}) g`);
    await owner.query(
      `WITH workflows_created AS (
         INSERT INTO workflows ("tenantId", name, steps)
         SELECT id, 'bench', $1::jsonb FROM tenants
         RETURNING id, "tenantId", steps
       )
       INSERT INTO workflow_versions ("workflowId", "tenantId", version, steps)
       SELECT id, "tenantId", 1, steps FROM workflows_created`,
      [steps],
    );
    await owner.query(`
      WITH t AS (SELECT v.*, row_number() OVER (ORDER BY v."tenantId") - 1 AS n FROM workflow_versions v)
      INSERT INTO executions ("tenantId", "workflowId", "workflowVersionId", status)
      SELECT t."tenantId", t."workflowId", t.id, 'pending'
        FROM generate_series(1, ${EXECUTIONS}) g JOIN t ON t.n = g % ${TENANTS}`);
    await owner.query(`
      INSERT INTO jobs ("tenantId", "executionId", "runAt")
      SELECT "tenantId", id, now() - interval '1 minute' FROM executions`);
    await owner.query('ANALYZE');

    for (let i = 0; i < PROCESSES; i++)
      await jest.isolateModulesAsync(async () => {
        const { startApp } = await import('../helpers/app');
        const { WorkerModule } = await import('../../src/app.module');
        const { JobRunnerService } =
          await import('../../src/engine/job-runner.service');
        // DataSource — з реєстру модулів цього воркера: токен Nest у кожного свій.
        const typeorm = await import('typeorm');
        const app = await startApp(WorkerModule);
        workers.push(app);
        runners.push(app.app.get(JobRunnerService));
        countStatements(app.app.get(typeorm.DataSource), counter);
      });
    // Статистика сервера оновлюється асинхронно: пауза, щоб засів не потрапив у дельту.
    await new Promise((r) => setTimeout(r, 1500));
    const before = await tableStats(owner);
    notifications = 0;

    const started = performance.now();
    for (const runner of runners) runner.start(LOOPS_PER_PROCESS);
    await waitFor(
      'all executions succeeded',
      async () => {
        const [row]: Array<{ n: number }> = await owner.query(
          `SELECT count(*)::int AS n FROM executions WHERE status = 'succeeded'`,
        );
        return row.n === EXECUTIONS;
      },
      { timeoutMs: 600_000, intervalMs: 100 },
    );
    const seconds = (performance.now() - started) / 1000;
    const snapshot = { ...counter };
    await new Promise((r) => setTimeout(r, 1500));
    const after = await tableStats(owner);

    const [doneSteps]: Array<{ n: number }> = await owner.query(
      `SELECT count(*)::int AS n FROM step_runs WHERE status = 'succeeded'`,
    );
    expect(doneSteps.n).toBe(EXECUTIONS * STEPS);
    const totalSteps = EXECUTIONS * STEPS;
    const hot = Object.fromEntries(
      after.map((a) => {
        const b = before.find((x) => x.relname === a.relname)!;
        const upd = a.upd - b.upd;
        return [
          a.relname,
          {
            updates: upd,
            hotShare: upd ? +((a.hot - b.hot) / upd).toFixed(3) : 0,
          },
        ];
      }),
    );
    const report = {
      executions: EXECUTIONS,
      stepsPerExecution: STEPS,
      seconds: +seconds.toFixed(1),
      stepsPerSecond: Math.round(totalSteps / seconds),
      statementsPerStep: +(snapshot.statements / totalSteps).toFixed(2),
      transactionsPerStep: +(snapshot.transactions / totalSteps).toFixed(2),
      statementsPerExecution: +(snapshot.statements / EXECUTIONS).toFixed(1),
      notificationsPerStep: +(notifications / totalSteps).toFixed(2),
      hot,
    };
    console.log(`step cost: ${JSON.stringify(report, null, 2)}`);
  });
});
