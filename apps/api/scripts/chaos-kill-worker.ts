/**
 * Chaos-сценарій: під навантаженням вбиває воркери (SIGKILL, без graceful shutdown) і
 * перевіряє, що кожне виконання завершилось, жоден завершений крок не виконано вдруге, а
 * зовнішній ефект кожного http-кроку стався рівно один раз.
 *
 * Запуск (з apps/api, стек з оверлеєм docker-compose.chaos.yml уже піднято — див. README):
 *   npm run chaos
 * Налаштування: CHAOS_EXECUTIONS (200), API_URL (http://localhost:3000),
 * DATABASE_URL (postgres://flowforge:flowforge@localhost:5432/flowforge),
 * ADMIN_TOKEN (інакше — з .env у корені репозиторію).
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
const API_URL = process.env.API_URL ?? 'http://localhost:3000';
const SINK_STATS_URL =
  process.env.SINK_STATS_URL ?? 'http://localhost:8080/stats';
const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://flowforge:flowforge@localhost:5432/flowforge';
const EXECUTIONS = Number(process.env.CHAOS_EXECUTIONS ?? 200);
const TIMEOUT_MS = 240_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (msg: string) =>
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

function adminToken(): string {
  if (process.env.ADMIN_TOKEN) return process.env.ADMIN_TOKEN;
  const env = parseEnv(readFileSync(join(ROOT, '.env'), 'utf8'));
  if (!env.ADMIN_TOKEN) throw new Error('ADMIN_TOKEN is not set');
  return env.ADMIN_TOKEN;
}

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
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
  });
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

interface SinkStats {
  requests: number;
  effects: number;
  repeatedKeys: number;
  missingKey: number;
}

async function sinkStats(): Promise<SinkStats> {
  return (await (await fetch(SINK_STATS_URL)).json()) as SinkStats;
}

async function main(): Promise<void> {
  // Лічильники отримувача накопичуються між запусками: рахуємо приріст за цей запуск.
  const before = await sinkStats();
  const workers = docker([...COMPOSE, 'ps', '-q', 'worker'])
    .split('\n')
    .filter(Boolean);
  if (workers.length < 2)
    throw new Error(`need at least 2 running workers, found ${workers.length}`);

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

  const started = Date.now();
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

  // Два раунди: вбити воркер посеред роботи, дати іншим працювати, підняти його знову.
  const kills: string[] = [];
  for (const [round, victim] of workers.slice(0, 2).entries()) {
    await sleep(round === 0 ? 2_000 : 4_000);
    log(`SIGKILL worker ${victim.slice(0, 12)}`);
    docker(['kill', '--signal', 'KILL', victim]);
    kills.push(victim.slice(0, 12));
    await sleep(3_000);
    log(`restarting worker ${victim.slice(0, 12)}`);
    docker(['start', victim]);
  }

  const db = await new DataSource({
    type: 'postgres',
    url: DATABASE_URL,
  }).initialize();
  try {
    const deadline = Date.now() + TIMEOUT_MS;
    let pending = EXECUTIONS;
    while (pending > 0) {
      if (Date.now() > deadline)
        throw new Error(
          `${pending} executions still unfinished after ${TIMEOUT_MS} ms`,
        );
      const rows: Array<{ pending: number }> = await db.query(
        `SELECT count(*)::int AS pending FROM executions
          WHERE id = ANY($1) AND status NOT IN ('succeeded', 'failed')`,
        [ids],
      );
      pending = rows[0].pending;
      if (pending > 0) await sleep(1_000);
    }
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);

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
    const sink: SinkStats = {
      requests: after.requests - before.requests,
      effects: after.effects - before.effects,
      repeatedKeys: after.repeatedKeys - before.repeatedKeys,
      missingKey: after.missingKey - before.missingKey,
    };

    const report = [
      `| Показник | Значення |`,
      `|---|---|`,
      `| Виконань поставлено | ${EXECUTIONS} |`,
      `| Убито воркерів (SIGKILL) | ${kills.length} (${kills.join(', ')}) |`,
      `| Час до завершення всіх виконань | ${elapsed} с |`,
      `| Виконань succeeded / failed | ${executions.succeeded} / ${executions.failed} |`,
      `| Рядків step_runs (очікується ${EXECUTIONS * 4}) | ${steps.rows} |`,
      `| Кроків, що мали понад 1 спробу (усього / http) | ${steps.repeated} / ${steps.reran} |`,
      `| Задач, повернутих reaper-ом після SIGKILL | ${jobs.reclaimed} |`,
      `| Задач у стані dead | ${jobs.dead} |`,
      `| Запитів до отримувача / унікальних ефектів | ${sink.requests} / ${sink.effects} |`,
      `| Ключів, що прийшли повторно (і не дали другого ефекту) | ${sink.repeatedKeys} |`,
    ].join('\n');
    console.log(`\n${report}\n`);

    const problems = [
      executions.succeeded !== EXECUTIONS &&
        `only ${executions.succeeded}/${EXECUTIONS} executions succeeded`,
      steps.rows !== EXECUTIONS * 4 &&
        `unexpected step_runs count ${steps.rows}`,
      sink.effects !== EXECUTIONS &&
        `receiver saw ${sink.effects} distinct effects, expected ${EXECUTIONS}`,
      sink.missingKey > 0 &&
        `${sink.missingKey} requests without Idempotency-Key`,
      jobs.reclaimed === 0 &&
        'no job was interrupted by the kills: the scenario proved nothing, run it again',
    ].filter(Boolean);
    if (problems.length > 0) {
      for (const p of problems) console.error(`FAIL: ${p as string}`);
      process.exitCode = 1;
      return;
    }
    log(
      'OK: every execution succeeded, no completed step re-ran, one effect per http step',
    );
  } finally {
    await db.destroy();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
