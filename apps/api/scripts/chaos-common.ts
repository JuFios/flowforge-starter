/**
 * Спільне для chaos-сценаріїв (README, «Chaos- і навантажувальні сценарії»): навантаження
 * `log → http (sink) → delay → log`, очікування завершення і перевірка гарантій за БД і
 * лічильниками отримувача.
 *
 * Налаштування: CHAOS_EXECUTIONS (200), API_URL (http://localhost:3000),
 * DATABASE_URL (postgres://flowforge:flowforge@localhost:5432/flowforge),
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
const API_URL = process.env.API_URL ?? 'http://localhost:3000';
const SINK_STATS_URL =
  process.env.SINK_STATS_URL ?? 'http://localhost:8080/stats';
const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://flowforge:flowforge@localhost:5432/flowforge';
export const EXECUTIONS = Number(process.env.CHAOS_EXECUTIONS ?? 200);
/** Кроків у workflow сценарію: рядків step_runs має бути рівно стільки на виконання. */
export const STEPS = 4;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const log = (msg: string) =>
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

function adminToken(): string {
  if (process.env.ADMIN_TOKEN) return process.env.ADMIN_TOKEN;
  const env = parseEnv(readFileSync(join(ROOT, '.env'), 'utf8'));
  if (!env.ADMIN_TOKEN) throw new Error('ADMIN_TOKEN is not set');
  return env.ADMIN_TOKEN;
}

export function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
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
export async function enqueueWorkload(): Promise<string[]> {
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
  log(`enqueueing ${EXECUTIONS} executions`);
  const ids: string[] = [];
  for (let n = 0; n < EXECUTIONS; n += 20) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(20, EXECUTIONS - n) }, (_, i) =>
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
  return new DataSource({ type: 'postgres', url: DATABASE_URL }).initialize();
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

export interface Outcome {
  succeeded: number;
  failed: number;
  stepRows: number;
  /** Кроків із понад однією спробою: усього / http. */
  repeatedSteps: number;
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
    `| Задач, повернутих reaper-ом (lease минув) | ${o.reclaimed} |`,
    `| Задач у стані dead | ${o.dead} |`,
    `| Запитів до отримувача / унікальних ефектів | ${o.sink.requests} / ${o.sink.effects} |`,
    `| Ключів, що прийшли повторно (і не дали другого ефекту) | ${o.sink.repeatedKeys} |`,
  ];
}

/** Порушення гарантій, спільних для всіх сценаріїв. */
export function guaranteeProblems(o: Outcome): string[] {
  return [
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
