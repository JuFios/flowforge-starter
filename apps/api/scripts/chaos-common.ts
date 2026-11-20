/**
 * Спільне для chaos-сценаріїв (README, «Chaos- і навантажувальні сценарії»): навантаження
 * `log → http (sink) → delay → log`, очікування завершення і перевірка гарантій за БД і
 * лічильниками отримувача.
 *
 * Налаштування: CHAOS_EXECUTIONS (200), API_URL (http://localhost:3000),
 * DATABASE_URL (власник схеми; інакше postgres://flowforge:<POSTGRES_PASSWORD із .env>@localhost:5432/flowforge),
 * SINK_STATS_URL (http://localhost:8080/stats), ADMIN_TOKEN (інакше — з .env у корені репозиторію).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { DataSource } from 'typeorm';

export const ROOT = join(__dirname, '../../../..');
export const COMPOSE = [
  'compose',
  '-f',
  join(ROOT, 'docker-compose.yml'),
  '-f',
  join(ROOT, 'docker-compose.chaos.yml'),
];
const LOG_SINCE = new Date().toISOString();
const API_URL = process.env.API_URL ?? 'http://localhost:3000';
const SINK_STATS_URL =
  process.env.SINK_STATS_URL ?? 'http://localhost:8080/stats';
/** Змінна з .env у корені репозиторію (як docker-compose), якщо її немає в оточенні. */
export function rootEnv(name: string): string {
  const fromProcess = process.env[name];
  if (fromProcess) return fromProcess;
  const env = parseEnv(readFileSync(join(ROOT, '.env'), 'utf8'));
  const value = env[name];
  if (!value) throw new Error(`${name} is not set (environment or .env)`);
  return value;
}

/**
 * Перевірки сценаріїв читають БД власником схеми (повз RLS): пароль суперкористувача Postgres —
 * той самий POSTGRES_PASSWORD, що й у compose.
 */
const databaseUrl = (): string =>
  process.env.DATABASE_URL ??
  `postgres://flowforge:${encodeURIComponent(rootEnv('POSTGRES_PASSWORD'))}@localhost:5432/flowforge`;
export const EXECUTIONS = Number(process.env.CHAOS_EXECUTIONS ?? 200);
/** Кроків у workflow сценарію: рядків step_runs має бути рівно стільки на виконання. */
export const STEPS = 4;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const log = (msg: string) =>
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

function adminToken(): string {
  return rootEnv('ADMIN_TOKEN');
}

export function docker(args: string[]): string {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

/** ID запущених контейнерів сервісу compose. */
export function containers(service: string): string[] {
  return docker([...COMPOSE, 'ps', '-q', service])
    .split('\n')
    .filter(Boolean);
}

async function call<T>(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export interface SinkStats {
  requests: number;
  effects: number;
  repeatedKeys: number;
  missingKey: number;
}

export async function sinkStats(): Promise<SinkStats> {
  return (await (await fetch(SINK_STATS_URL)).json()) as SinkStats;
}

/** Тенант, workflow сценарію і EXECUTIONS виконань (пачками по 20). Повертає ID виконань. */
export async function enqueueRound(
  round: number,
  rounds: number,
): Promise<string[]> {
  const count =
    Math.floor((EXECUTIONS * (round + 1)) / rounds) -
    Math.floor((EXECUTIONS * round) / rounds);
  if (!count) throw new Error('each fault round requires its own workload');
  const { apiKey } = await call<{ apiKey: string }>(
    'POST',
    '/tenants',
    { 'x-admin-token': adminToken() },
    { name: `chaos-${Date.now()}` },
  );
  const auth = { 'x-api-key': apiKey };
  const wf = await call<{ id: string }>('POST', '/workflows', auth, {
    name: 'chaos',
    steps: [
      { id: 'start', type: 'log', message: 'chaos {{ input.n }}' },
      {
        id: 'charge',
        type: 'http',
        method: 'POST',
        url: 'http://sink:8080/effect',
      },
      { id: 'wait', type: 'delay', ms: 2_000 },
      { id: 'finish', type: 'log', message: 'done {{ input.n }}' },
    ],
  });
  log(`enqueueing ${count} executions for round ${round + 1}`);
  const ids: string[] = [];
  for (let n = 0; n < count; n += 20) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(20, count - n) }, (_, i) =>
        call<{ id: string }>('POST', `/workflows/${wf.id}/run`, auth, {
          n: n + i,
        }),
      ),
    );
    ids.push(...batch.map((e) => e.id));
  }
  return ids;
}

export function openDatabase(): Promise<DataSource> {
  return new DataSource({ type: 'postgres', url: databaseUrl() }).initialize();
}

/** Чекає, поки всі виконання стануть succeeded/failed. */
export async function waitUntilFinished(
  db: DataSource,
  ids: string[],
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows: Array<{ pending: number }> = await db.query(
      `SELECT count(*)::int AS pending FROM executions
        WHERE id = ANY($1) AND status NOT IN ('succeeded', 'failed')`,
      [ids],
    );
    if (rows[0].pending === 0) return;
    if (Date.now() > deadline)
      throw new Error(
        `${rows[0].pending} executions still unfinished after ${timeoutMs} ms`,
      );
    await sleep(1_000);
  }
}

/** Кожна аварія має окрему групу задач. Лічильники з першої аварії не можуть
 * підтвердити другу. Після рестарту БД з'єднуємось новим пулом. */
export async function finishRound(
  ids: string[],
  timeoutMs: number,
): Promise<number> {
  const db = await openDatabase();
  try {
    await waitUntilFinished(db, ids, timeoutMs);
    const [row]: { interrupted: number }[] = await db.query(
      `SELECT count(*)::int AS interrupted FROM jobs j WHERE j."executionId"=ANY($1)
        AND (j."lastError" LIKE 'lease expired%' OR EXISTS (
          SELECT FROM step_runs s WHERE s."executionId"=j."executionId" AND s.attempts>1))`,
      [ids],
    );
    return row.interrupted;
  } finally {
    await db.destroy();
  }
}

interface CompletedStep {
  callKey: string | null;
  finishedAt: string;
  id: string;
  stepId: string;
  idempotencyKey: string;
  attempts: number;
}

export interface CheckpointObservation extends CompletedStep {
  calls?: number;
}

async function completedSteps(
  db: DataSource,
  ids: string[],
): Promise<CompletedStep[]> {
  return db.query(
    `SELECT s.id, s."stepId", s."idempotencyKey", s.attempts, s."finishedAt"::text AS "finishedAt",
           CASE WHEN s."stepId" = 'charge' THEN s."idempotencyKey"::text
                WHEN s."stepId" IN ('start','finish') THEN e."correlationId" || ':' || s."stepId"
           END AS "callKey"
      FROM step_runs s JOIN executions e ON e.id = s."executionId"
     WHERE e.id = ANY($1) AND s.status = 'succeeded'`,
    [ids],
  );
}

async function callCounts(): Promise<Record<string, number>> {
  const response = await fetch(new URL('/counts', SINK_STATS_URL), {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(`receiver request counts: HTTP ${response.status}`);
  const counts = (await response.json()) as Record<string, number>;
  for (const worker of containers('worker')) {
    const lines = docker(['logs', '--since', LOG_SINCE, worker]).split('\n');
    for (const line of lines) {
      if (!line.startsWith('{')) continue;
      const record = JSON.parse(line) as {
        context?: string;
        correlationId?: string;
        msg?: unknown;
        stepId?: string;
      };
      if (
        record.context !== 'StepExecutor' ||
        !record.correlationId ||
        record.msg !== 'log step recorded its message' ||
        (record.stepId !== 'start' && record.stepId !== 'finish')
      )
        continue;
      const key = `${record.correlationId}:${record.stepId}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  return counts;
}

/** Фіксуємо завершені кроки перед кожним збоєм. Перше спостереження лишається
 * точкою відліку для обох раундів, навіть якщо між ними крок запустили знову. */
export async function captureCheckpoints(
  ids: string[],
  observed: Map<string, CheckpointObservation>,
): Promise<void> {
  const db = await openDatabase();
  try {
    const completed = await completedSteps(db, ids);
    const counts = await callCounts();
    for (const step of completed) {
      if (observed.has(step.id)) continue;
      const calls = step.callKey ? counts[step.callKey] : undefined;
      if (step.stepId !== 'wait' && !calls)
        throw new Error(`no observed call for completed step ${step.id}`);
      observed.set(step.id, { ...step, calls });
    }
  } finally {
    await db.destroy();
  }
}

export function replayedCheckpoints(
  before: Map<string, CheckpointObservation>,
  after: CompletedStep[],
  counts: Record<string, number>,
): number {
  const final = new Map(after.map((step) => [step.id, step]));
  let changed = 0;
  for (const step of before.values()) {
    const result = final.get(step.id);
    if (
      result?.attempts !== step.attempts ||
      result.idempotencyKey !== step.idempotencyKey ||
      result.finishedAt !== step.finishedAt ||
      (step.callKey !== null && counts[step.callKey] !== step.calls)
    )
      changed++;
  }
  return changed;
}

export interface Outcome {
  succeeded: number;
  failed: number;
  stepRows: number;
  /** Кроків із понад однією спробою: усього / http. */
  repeatedSteps: number;
  observedSteps: number;
  observedHttp: number;
  changedCheckpoints: number;
  repeatedHttp: number;
  /** Задач, повернутих reaper-ом (lease минув). */
  reclaimed: number;
  dead: number;
  sink: SinkStats;
}

/** Стан виконань у БД і приріст лічильників отримувача від `before`. */
export async function collectOutcome(
  db: DataSource,
  ids: string[],
  before: SinkStats,
  observed: Map<string, CheckpointObservation>,
): Promise<Outcome> {
  const q = async <T>(sql: string): Promise<T> => {
    const rows: T[] = await db.query(sql, [ids]);
    return rows[0];
  };
  const executions = await q<{ succeeded: number; failed: number }>(
    `SELECT count(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
            count(*) FILTER (WHERE status = 'failed')::int AS failed
       FROM executions WHERE id = ANY($1)`,
  );
  const steps = await q<{ rows: number; repeated: number; reran: number }>(
    `SELECT count(*)::int AS rows,
            count(*) FILTER (WHERE attempts > 1)::int AS repeated,
            count(*) FILTER (WHERE attempts > 1 AND "stepId" = 'charge')::int AS reran
       FROM step_runs WHERE "executionId" = ANY($1)`,
  );
  const jobs = await q<{ reclaimed: number; dead: number }>(
    `SELECT count(*) FILTER (WHERE "lastError" LIKE 'lease expired%')::int AS reclaimed,
            count(*) FILTER (WHERE status = 'dead')::int AS dead
       FROM jobs WHERE "executionId" = ANY($1)`,
  );
  const after = await sinkStats();
  return {
    ...executions,
    stepRows: steps.rows,
    observedSteps: observed.size,
    observedHttp: [...observed.values()].filter(
      (step) => step.stepId === 'charge',
    ).length,
    changedCheckpoints: replayedCheckpoints(
      observed,
      await completedSteps(db, ids),
      await callCounts(),
    ),
    repeatedSteps: steps.repeated,
    repeatedHttp: steps.reran,
    ...jobs,
    sink: {
      requests: after.requests - before.requests,
      effects: after.effects - before.effects,
      repeatedKeys: after.repeatedKeys - before.repeatedKeys,
      missingKey: after.missingKey - before.missingKey,
    },
  };
}

/** Рядки таблиці звіту (Markdown) зі спільними показниками. */
export function outcomeRows(o: Outcome, elapsedSeconds: string): string[] {
  return [
    `| Виконань поставлено | ${EXECUTIONS} |`,
    `| Час до завершення всіх виконань | ${elapsedSeconds} с |`,
    `| Виконань succeeded / failed | ${o.succeeded} / ${o.failed} |`,
    `| Рядків step_runs (очікується ${EXECUTIONS * STEPS}) | ${o.stepRows} |`,
    `| Кроків, що мали понад 1 спробу (усього / http) | ${o.repeatedSteps} / ${o.repeatedHttp} |`,
    `| Чекпоінтів до збоїв (з них HTTP) / змінених після відновлення | ${o.observedSteps} (${o.observedHttp}) / ${o.changedCheckpoints} |`,
    `| Задач, повернутих reaper-ом (lease минув) | ${o.reclaimed} |`,
    `| Задач у стані dead | ${o.dead} |`,
    `| Запитів до отримувача / унікальних ефектів | ${o.sink.requests} / ${o.sink.effects} |`,
    `| Ключів, що прийшли повторно (і не дали другого ефекту) | ${o.sink.repeatedKeys} |`,
  ];
}

/** Порушення гарантій, спільних для всіх сценаріїв. */
export function guaranteeProblems(o: Outcome): string[] {
  return [
    !o.observedHttp && 'no completed HTTP step was observed before a fault',
    o.changedCheckpoints > 0 &&
      `${o.changedCheckpoints} completed checkpoints changed or received another call`,
    o.dead > 0 && `${o.dead} dead jobs`,
    o.succeeded !== EXECUTIONS &&
      `only ${o.succeeded}/${EXECUTIONS} executions succeeded`,
    o.stepRows !== EXECUTIONS * STEPS &&
      `unexpected step_runs count ${o.stepRows}`,
    o.sink.effects !== EXECUTIONS &&
      `receiver saw ${o.sink.effects} distinct effects, expected ${EXECUTIONS}`,
    o.sink.missingKey > 0 &&
      `${o.sink.missingKey} requests without Idempotency-Key`,
  ].filter((p): p is string => typeof p === 'string');
}

/** Друкує звіт; ненульовий код завершення, якщо є порушення. */
export function finish(report: string[], problems: string[], ok: string): void {
  console.log(`\n| Показник | Значення |\n|---|---|\n${report.join('\n')}\n`);
  if (problems.length > 0) {
    for (const p of problems) console.error(`FAIL: ${p}`);
    process.exitCode = 1;
    return;
  }
  log(`OK: ${ok}`);
}
