/**
 * Навантажувальний сценарій справедливого планування (ТЗ 3.3.5; README, «Справедливе планування →
 * Вимірювання»). Стенд — docker compose з оверлеєм docker-compose.chaos.yml (отримувач `sink`
 * відповідає за 300 мс, 2 воркери × 4 цикли).
 *
 * Прогін (кожен — нові тенанти):
 *  1. «B сам»: 30 виконань тенанта B (`http → sink`) через API, по одному кожні 200 мс;
 *  2. «A сам»: 20 000 виконань тенанта A ставляться в чергу одразу (SQL власником схеми — швидко),
 *     пропускна здатність A за 20 с;
 *  3. «B під backlog-ом A»: ті самі 30 виконань B, поки черга A глибока й endpoint сповіщень A
 *     відповідає 503.
 * Після прогону очищаються невиконані задачі й черга сповіщень A.
 *
 * Метрики — за годинником БД: очікування B — від створення виконання до початку першого кроку;
 * повна тривалість — до завершення; p95 захоплення — з гістограми воркерів
 * flowforge_job_claim_duration_seconds.
 *
 * Критерії (кожен прогін; провал будь-якого — код виходу 1):
 *  - успішно 30 з 30 виконань B, фаза B ≤ 120 с;
 *  - коли завершилось останнє виконання B, у черзі A — понад 50% backlog-у;
 *  - p95 очікування B під навантаженням ≤ 3 × p95 (B сам) + 1 с і ≤ 5 с;
 *  - p95 повної тривалості B під навантаженням ≤ 2 × p95 (B сам) + 2 с;
 *  - p95 захоплення ≤ 100 мс.
 * `--baseline` — для порівняння з попередньою версією (README): без критеріїв і без лімітів
 * тенанта, фаза B — до завершення всіх виконань B, але не довше 20 хв.
 *
 *   docker compose -f docker-compose.yml -f docker-compose.chaos.yml up -d --build --wait
 *   (cd apps/api && npm run load:fairness)
 *
 * Налаштування: LOAD_RUNS (3), API_URL (http://localhost:3000), DATABASE_URL (власник схеми;
 * інакше postgres://flowforge:<POSTGRES_PASSWORD із .env>@localhost:5432/flowforge), ADMIN_TOKEN
 * (інакше — з .env у корені репозиторію).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { DataSource } from 'typeorm';

const ROOT = join(__dirname, '../../../..');
const COMPOSE = [
  'compose',
  '-f',
  join(ROOT, 'docker-compose.yml'),
  '-f',
  join(ROOT, 'docker-compose.chaos.yml'),
];
const BASELINE = process.argv.includes('--baseline');
export function runCount(value: string | undefined): number {
  if (value === undefined) return 3;
  if (!/^[1-9]\d*$/.test(value) || Number(value) > 30)
    throw new Error('LOAD_RUNS must be an integer between 1 and 30');
  return Number(value);
}
const API_URL = process.env.API_URL ?? 'http://localhost:3000';
const A_JOBS = 20_000;
const B_RUNS = 30;
const B_EVERY_MS = 200;
const A_ALONE_MS = 20_000;
const B_PHASE_LIMIT_MS = BASELINE ? 20 * 60_000 : 120_000;
const SINK_URL = 'http://sink:8080/effect';
const UNAVAILABLE_URL = 'http://sink:8080/unavailable';
const NOTIFICATIONS = '/tenants/me/notifications';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (msg: string) =>
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

function rootEnv(name: string): string {
  const fromProcess = process.env[name];
  if (fromProcess) return fromProcess;
  const value = parseEnv(readFileSync(join(ROOT, '.env'), 'utf8'))[name];
  if (!value) throw new Error(`${name} is not set (environment or .env)`);
  return value;
}

function send(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
  apiUrl = API_URL,
): Promise<Response> {
  return fetch(`${apiUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
}

async function call<T>(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
  apiUrl = API_URL,
): Promise<T> {
  const res = await send(method, path, headers, body, apiUrl);
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`${method} ${path}: HTTP ${res.status}`);
  }
  return readLoadResponse<T>(res);
}

export async function readLoadResponse<T>(res: Response): Promise<T> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error('empty API response');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 64 * 1024) {
        await reader.cancel();
        throw new Error('API response exceeds the size limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) as T;
}

interface Tenant {
  id: string;
  auth: Record<string, string>;
  workflow: string;
}

async function tenant(name: string): Promise<Tenant> {
  const admin = { 'x-admin-token': rootEnv('ADMIN_TOKEN') };
  const created = await call<{ id: string; apiKey: string }>(
    'POST',
    '/tenants',
    admin,
    { name },
  );
  const auth = { 'x-api-key': created.apiKey };
  const wf = await call<{ id: string }>('POST', '/workflows', auth, {
    name: `${name}-load`,
    steps: [{ id: 'call', type: 'http', method: 'POST', url: SINK_URL }],
  });
  return { id: created.id, auth, workflow: wf.id };
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

/** Сумарні кумулятивні бакети гістограми тривалості захоплення з усіх воркерів. */
type Buckets = Map<number, number>;
type Snapshot = Map<string, Buckets>;
function claimBuckets(): Snapshot {
  const snapshot: Snapshot = new Map();
  const ids = execFileSync('docker', [...COMPOSE, 'ps', '-q', 'worker'], {
    encoding: 'utf8',
    timeout: 10_000,
  })
    .split('\n')
    .filter(Boolean);
  for (const id of ids) {
    const text = execFileSync(
      'docker',
      ['exec', id, 'wget', '-qO-', 'http://127.0.0.1:3100/metrics'],
      { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 * 1024 },
    );
    const started = /^process_start_time_seconds (\d+(?:\.\d+)?)$/m.exec(
      text,
    )?.[1];
    if (!started) throw new Error('worker start time is missing');
    const buckets: Buckets = new Map();
    snapshot.set(id + '/' + started, buckets);
    for (const [, le, count] of text.matchAll(
      /^flowforge_job_claim_duration_seconds_bucket\{le="([^"]+)"\} (\d+)$/gm,
    )) {
      const bound = le === '+Inf' ? Infinity : Number(le);
      buckets.set(bound, (buckets.get(bound) ?? 0) + Number(count));
    }
  }
  return snapshot;
}

/** p95 (верхня межа бакета) захоплень між двома знімками гістограми, мс. */
function bucketDelta(before: Buckets, after: Buckets): Buckets | undefined {
  if (!before.has(Infinity) || before.size !== after.size || before.size < 2)
    return;
  const delta: Buckets = new Map();
  let priorBefore = 0,
    priorAfter = 0,
    priorDelta = 0;
  for (const bound of [...before.keys()].sort((a, b) => a - b)) {
    const old = before.get(bound)!;
    const now = after.get(bound);
    if (
      now === undefined ||
      !Number.isSafeInteger(old) ||
      !Number.isSafeInteger(now) ||
      old < priorBefore ||
      now < priorAfter ||
      now - old < priorDelta
    )
      return;
    delta.set(bound, now - old);
    priorBefore = old;
    priorAfter = now;
    priorDelta = now - old;
  }
  return delta;
}

function percentileBound(delta: Buckets | undefined): number | undefined {
  const total = delta?.get(Infinity);
  if (!delta || !total) return;
  for (const [bound, n] of delta) if (n >= 0.95 * total) return bound * 1000;
}

export function workerClaimP95(
  before: Snapshot,
  after: Snapshot,
): number | undefined {
  if (before.size < 2 || before.size !== after.size) return;
  let total: Buckets | undefined;
  for (const [worker, first] of before) {
    const last = after.get(worker);
    const delta = last && bucketDelta(first, last);
    if (!delta) return;
    if (!total) {
      total = delta;
      continue;
    }
    if (total.size !== delta.size) return;
    for (const [bound, n] of delta) {
      const prior = total.get(bound);
      if (prior === undefined) return;
      total.set(bound, prior + n);
    }
  }
  return percentileBound(total);
}

interface BPhase {
  succeeded: number;
  seconds: number;
  waitP95: number;
  durationP95: number;
  /** Скільки задач A ще в черзі, коли завершилось останнє виконання B. */
  aLeftAtEnd?: number;
}

/** 30 виконань B по одному кожні 200 мс; чекає їх завершення. */
async function runB(db: DataSource, b: Tenant, a?: Tenant): Promise<BPhase> {
  const started = performance.now();
  const ids: string[] = [];
  for (let i = 0; i < B_RUNS; i++) {
    if (performance.now() - started >= B_PHASE_LIMIT_MS)
      throw new Error('B submission deadline exceeded');
    const tick = Date.now();
    ids.push(
      (
        await call<{ id: string }>(
          'POST',
          `/workflows/${b.workflow}/run`,
          b.auth,
          { i },
        )
      ).id,
    );
    await sleep(Math.max(0, B_EVERY_MS - (Date.now() - tick)));
  }
  let aLeftAtEnd: number | undefined;
  for (;;) {
    const [{ pending }]: Array<{ pending: number }> = await db.query(
      `SELECT count(*)::int AS pending FROM executions
        WHERE id = ANY ($1) AND status NOT IN ('succeeded', 'failed')`,
      [ids],
    );
    if (pending === 0) break;
    if (performance.now() - started > B_PHASE_LIMIT_MS) break;
    await sleep(250);
  }
  if (a) {
    const [{ left }]: Array<{ left: number }> = await db.query(
      `SELECT count(*)::int AS left FROM jobs WHERE "tenantId" = $1 AND status = 'queued'`,
      [a.id],
    );
    aLeftAtEnd = left;
  }
  const rows: Array<{
    status: string;
    wait: number | null;
    duration: number | null;
  }> = await db.query(
    `SELECT e.status,
            EXTRACT(EPOCH FROM (SELECT min(s."startedAt") FROM step_runs s
                                 WHERE s."executionId" = e.id) - e."createdAt") AS wait,
            EXTRACT(EPOCH FROM e."finishedAt" - e."createdAt") AS duration
       FROM executions e WHERE e.id = ANY ($1)`,
    [ids],
  );
  const done = rows.filter((r) => r.status === 'succeeded');
  if (
    done.length !== B_RUNS ||
    performance.now() - started > B_PHASE_LIMIT_MS ||
    done.some((row) =>
      [row.wait, row.duration].some(
        (v) => v === null || !Number.isFinite(Number(v)) || Number(v) < 0,
      ),
    )
  )
    throw new Error(
      `incomplete B measurement: ${done.length}/${B_RUNS} within ${B_PHASE_LIMIT_MS} ms required`,
    );
  return {
    succeeded: done.length,
    seconds: (performance.now() - started) / 1000,
    waitP95: done.length
      ? percentile(
          done.map((r) => Number(r.wait)),
          0.95,
        )
      : NaN,
    durationP95: done.length
      ? percentile(
          done.map((r) => Number(r.duration)),
          0.95,
        )
      : NaN,
    aLeftAtEnd,
  };
}

/** Backlog A — одним оператором власником схеми (через API це зайняло б хвилини). */
async function enqueueA(db: DataSource, a: Tenant): Promise<void> {
  await db.query(
    `WITH v AS (SELECT id FROM workflow_versions WHERE "workflowId" = $2 ORDER BY version DESC LIMIT 1),
          e AS (INSERT INTO executions ("tenantId", "workflowId", "workflowVersionId", input, trigger)
                SELECT $1, $2, v.id, jsonb_build_object('n', g), 'api'
                  FROM generate_series(1, $3) g, v
                RETURNING id)
     INSERT INTO jobs ("tenantId", "executionId", "runAt") SELECT $1, e.id, now() FROM e`,
    [a.id, a.workflow, A_JOBS],
  );
}

async function aSucceeded(db: DataSource, a: Tenant): Promise<number> {
  const [{ n }]: Array<{ n: number }> = await db.query(
    `SELECT count(*)::int AS n FROM executions WHERE "tenantId" = $1 AND status = 'succeeded'`,
    [a.id],
  );
  return n;
}

/** Невиконаний backlog A більше не потрібен: прибрати, щоб наступний прогін почався з нуля. */
async function dropA(db: DataSource, a: Tenant): Promise<void> {
  const until = performance.now() + 120_000;
  while (performance.now() < until) {
    await db.query(
      // Задача, що чекає на повтор, уже має кроки: їх видаляємо в тому самому операторі (FK
      // NO ACTION перевіряється в кінці оператора, тож пачка атомарна).
      `WITH batch AS MATERIALIZED (
           SELECT id FROM jobs WHERE "tenantId"=$1 AND status='queued'
           ORDER BY id LIMIT 200 FOR UPDATE SKIP LOCKED),
       gone AS (DELETE FROM jobs USING batch WHERE jobs.id = batch.id
         RETURNING "executionId"),
       steps AS (DELETE FROM step_runs s USING gone WHERE s."executionId"=gone."executionId")
       DELETE FROM executions e USING gone WHERE e.id=gone."executionId"`,
      [a.id],
    );
    const [{ pending }]: Array<{ pending: number }> = await db.query(
      `SELECT count(*)::int AS pending FROM jobs WHERE "tenantId"=$1 AND status IN ('queued','running')`,
      [a.id],
    );
    if (pending === 0) return;
    await sleep(100);
  }
  throw new Error(`backlog cleanup deadline exceeded for tenant ${a.id}`);
}

interface LoadNotifications {
  apiUrl: string;
  endpoint: string;
}

function setLoadNotifications(
  a: Tenant,
  notifications: LoadNotifications,
  enabled: boolean,
) {
  return call(
    'PUT',
    NOTIFICATIONS,
    a.auth,
    { url: notifications.endpoint, enabled },
    notifications.apiUrl,
  );
}

async function cleanupBacklog(
  db: DataSource,
  a: Tenant,
  notifications: LoadNotifications | undefined,
): Promise<void> {
  if (notifications) await setLoadNotifications(a, notifications, false);
  await dropA(db, a);
  if (!notifications) return;

  // Після паузи воркер не захоплює нову подію. Чекаємо завершення чинних спроб
  // або закінчення lease (до 125 с для максимального таймауту доставки).
  const until = performance.now() + 125_000;
  while (performance.now() < until) {
    const [{ active }]: Array<{ active: boolean }> = await db.query(
      `SELECT EXISTS (SELECT 1 FROM outbox_events WHERE "tenantId" = $1
        AND status = 'sending' AND "leaseUntil" > clock_timestamp()) AS active`,
      [a.id],
    );
    if (!active) {
      // Штатний DELETE переводить події з простроченим lease у pending і закриває їхні спроби.
      const removed = await send(
        'DELETE',
        NOTIFICATIONS,
        a.auth,
        undefined,
        notifications.apiUrl,
      );
      await removed.body?.cancel();
      if (removed.status !== 204)
        throw new Error(`DELETE ${NOTIFICATIONS}: HTTP ${removed.status}`);
      await call(
        'POST',
        NOTIFICATIONS + '/events/discard',
        a.auth,
        undefined,
        notifications.apiUrl,
      );
      return;
    }
    await sleep(100);
  }
  throw new Error(`notification cleanup deadline exceeded for tenant ${a.id}`);
}

export async function withBacklog<T>(
  db: DataSource,
  a: Tenant,
  measure: () => Promise<T>,
  notifications?: LoadNotifications,
): Promise<T> {
  let failure: unknown;
  try {
    if (notifications) await setLoadNotifications(a, notifications, true);
    await enqueueA(db, a);
    return await measure();
  } catch (err) {
    failure = err;
    throw err;
  } finally {
    await cleanupBacklog(db, a, notifications).catch((cleanup: unknown) => {
      if (failure)
        throw new AggregateError(
          [failure, cleanup],
          'measurement and cleanup failed',
        );
      throw cleanup;
    });
  }
}

interface Run {
  alone: BPhase;
  loaded: BPhase;
  aPerSecond: number;
  aDuringB: number;
  outboxFailuresDuringB?: number;
  claimP95Ms?: number;
}

export function problems(run: Run): string[] {
  const p: string[] = [];
  const { alone, loaded } = run;
  for (const [label, phase] of Object.entries({ alone, loaded })) {
    if (phase.succeeded !== B_RUNS || phase.seconds > B_PHASE_LIMIT_MS / 1000)
      p.push(
        `B ${label}: ${phase.succeeded}/${B_RUNS} succeeded in ${phase.seconds.toFixed(1)} s`,
      );
  }
  if (!(run.aDuringB > 0) || !(run.aPerSecond > 0))
    p.push('A must complete work in both phases');
  if (!(Number(run.outboxFailuresDuringB) > 0))
    p.push(
      'A must record HTTP 503 from its notification endpoint during the loaded phase',
    );
  if ((loaded.aLeftAtEnd ?? 0) <= A_JOBS / 2)
    p.push(`A had ${loaded.aLeftAtEnd} of ${A_JOBS} queued when B finished`);
  const waitBound = Math.min(3 * alone.waitP95 + 1, 5);
  if (!(loaded.waitP95 <= waitBound))
    p.push(
      `B p95 wait ${loaded.waitP95.toFixed(2)} s > ${waitBound.toFixed(2)} s`,
    );
  const durationBound = 2 * alone.durationP95 + 2;
  if (!(loaded.durationP95 <= durationBound))
    p.push(
      `B p95 duration ${loaded.durationP95.toFixed(2)} s > ${durationBound.toFixed(2)} s`,
    );
  if (
    run.claimP95Ms === undefined ||
    !Number.isFinite(run.claimP95Ms) ||
    run.claimP95Ms > 100
  )
    p.push(`claim p95 ${run.claimP95Ms ?? '?'} ms > 100 ms`);
  return p;
}

async function main(): Promise<void> {
  const count = runCount(process.env.LOAD_RUNS);
  const db = await new DataSource({
    connectTimeoutMS: 5000,
    extra: { statement_timeout: 30_000, query_timeout: 35_000 },
    type: 'postgres',
    url:
      process.env.DATABASE_URL ??
      `postgres://flowforge:${encodeURIComponent(rootEnv('POSTGRES_PASSWORD'))}@localhost:5432/flowforge`,
  }).initialize();
  const runs: Run[] = [];
  try {
    for (let run = 1; run <= count; run++) {
      const stamp = Date.now();
      const b = await tenant(`load-b-${stamp}`);
      const a = await tenant(`load-a-${stamp}`);
      if (!BASELINE) {
        // Ліміти A вище за кількість слотів і backlog: справедливість — не через ліміти.
        await call(
          'PATCH',
          `/tenants/${a.id}/limits`,
          {
            'x-admin-token': rootEnv('ADMIN_TOKEN'),
          },
          {
            maxQueueSize: 30_000,
            maxConcurrentExecutions: 16,
            maxOutboxEvents: 30_000,
          },
        );
      }

      log(`run ${run}: B alone`);
      try {
        const alone = await runB(db, b);

        log(`run ${run}: A alone (${A_JOBS} queued, ${A_ALONE_MS / 1000} s)`);
        const notifications = BASELINE
          ? undefined
          : { apiUrl: API_URL, endpoint: UNAVAILABLE_URL };
        const measure = async () => {
          const before = await aSucceeded(db, a);
          await sleep(A_ALONE_MS);
          const aPerSecond =
            ((await aSucceeded(db, a)) - before) / (A_ALONE_MS / 1000);

          log(`run ${run}: B under the backlog of A`);
          const claimsBefore = BASELINE
            ? new Map<string, Buckets>()
            : claimBuckets();
          const aBeforeB = await aSucceeded(db, a);
          const [{ started }]: Array<{ started: string }> = await db.query(
            'SELECT clock_timestamp()::text AS started',
          );
          const loaded = await runB(db, b, a);
          const aDuringB = (await aSucceeded(db, a)) - aBeforeB;
          const failures: Array<{ count: number }> = BASELINE
            ? []
            : await db.query(
                `SELECT count(*)::int AS count FROM outbox_attempts
                WHERE "tenantId"=$1 AND "httpStatus"=503 AND "startedAt">=$2`,
                [a.id, started],
              );
          const claimP95Ms = BASELINE
            ? undefined
            : workerClaimP95(claimsBefore, claimBuckets());
          return {
            alone,
            loaded,
            aPerSecond,
            aDuringB,
            outboxFailuresDuringB: failures[0]?.count,
            claimP95Ms,
          };
        };
        const result = await withBacklog(db, a, measure, notifications);
        runs.push(result);
      } finally {
        await dropA(db, b);
      }
    }
  } finally {
    await db.destroy();
  }

  const fmt = (v: number | undefined, unit = 's') =>
    v === undefined || Number.isNaN(v) ? '—' : `${v.toFixed(2)} ${unit}`;
  console.log(
    `\nfairness load (${BASELINE ? 'baseline' : 'this version'}; sink 300 ms, A ${A_JOBS} queued, B ${B_RUNS} runs every ${B_EVERY_MS} ms):`,
  );
  console.log(
    '| run | B alone p95 wait | B alone p95 duration | A alone jobs/s | B under A: succeeded | B phase | p95 wait | p95 duration | A queued at the end | A notification attempts with 503 | claim p95 |',
  );
  console.log('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const [i, r] of runs.entries())
    console.log(
      `| ${i + 1} | ${fmt(r.alone.waitP95)} | ${fmt(r.alone.durationP95)} | ${r.aPerSecond.toFixed(1)} | ${r.loaded.succeeded}/${B_RUNS} | ${fmt(r.loaded.seconds)} | ${fmt(r.loaded.waitP95)} | ${fmt(r.loaded.durationP95)} | ${r.loaded.aLeftAtEnd ?? '—'} | ${r.outboxFailuresDuringB ?? '—'} | ${fmt(r.claimP95Ms, 'ms')} |`,
    );
  if (BASELINE) return;
  const failed = runs.flatMap((r, i) =>
    problems(r).map((p) => `run ${i + 1}: ${p}`),
  );
  if (failed.length) {
    console.error(`\nFAIL\n  ${failed.join('\n  ')}`);
    process.exit(1);
  }
  console.log('\nOK: every run meets the fairness criteria');
}

if (require.main === module)
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
