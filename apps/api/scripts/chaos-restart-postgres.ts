/**
 * Chaos-сценарій: під навантаженням двічі аварійно зупиняє й запускає Postgres
 * і перевіряє, що воркери й API пережили це без перезапуску процесів, кожне виконання
 * завершилось, жоден завершений крок не виконано вдруге, а зовнішній ефект кожного http-кроку
 * стався рівно один раз (один ефект на Idempotency-Key).
 *
 * Запуск (з apps/api, стек з оверлеєм docker-compose.chaos.yml уже піднято — див. README):
 *   npm run chaos:postgres
 * Налаштування — див. chaos-common.ts.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { checkpointWriteIsBlocked } from './chaos-checkpoint-lock';
import {
  captureCheckpoints,
  captureGatedPrefix,
  CheckpointObservation,
  collectOutcome,
  COMPOSE,
  containers,
  docker,
  enqueueRound,
  finishRound,
  finish,
  guaranteeProblems,
  log,
  openDatabase,
  outcomeRows,
  releaseEffect,
  sinkStats,
  sleep,
} from './chaos-common';

const TIMEOUT_MS = 240_000;
const RESTARTS = 2;

/** Ідентичність процесу контейнера: якщо він перезапускався, StartedAt зміниться. */
function processState(id: string): string {
  return docker([
    'inspect',
    '-f',
    '{{.State.StartedAt}} restarts={{.RestartCount}} running={{.State.Running}}',
    id,
  ]);
}

function health(id: string): string {
  return docker([
    'inspect',
    '-f',
    '{{if .State.Health}}{{.State.Health.Status}}{{end}}',
    id,
  ]);
}

async function waitHealthy(ids: string[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (ids.some((id) => health(id) !== 'healthy')) {
    if (Date.now() > deadline)
      throw new Error(
        `not healthy after ${timeoutMs} ms: ${ids
          .filter((id) => health(id) !== 'healthy')
          .map((id) => id.slice(0, 12))
          .join(', ')}`,
      );
    await sleep(500);
  }
}

/** Рядки логу контейнера (stdout і stderr) з моменту `since`, що містять `text`. */
function countLogLines(id: string, since: string, text: string): number {
  const out = spawnSync('docker', ['logs', '--since', since, id], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return `${out.stdout}\n${out.stderr}`
    .split('\n')
    .filter((l) => l.includes(text)).length;
}

/** Sink приймає HTTP-ефект і чекає дозволу віддати відповідь. У цей час фікстура
 * блокує рядок конкретного чекпоінта. Після відповіді sink воркер мусить реально
 * чекати на запис, перш ніж PostgreSQL отримає SIGKILL. */
async function restartAtCheckpoint(
  executionId: string,
  token: string,
  observed: Map<string, CheckpointObservation>,
): Promise<{ checkpoint: string; started: number }> {
  const db = await openDatabase();
  const gate = db.createQueryRunner();
  let crashed = false;
  try {
    await gate.startTransaction();
    await gate.query("SET LOCAL statement_timeout = '3s'");
    const deadline = Date.now() + 30_000;
    let checkpoint: string | undefined;
    while (Date.now() < deadline) {
      const rows = (await gate.query(
        `SELECT s.id FROM step_runs s WHERE s."executionId"=$1
          AND s."stepId"='charge' AND s.status='running'
          FOR UPDATE OF s SKIP LOCKED`,
        [executionId],
      )) as { id: string }[];
      checkpoint = rows[0]?.id;
      if (checkpoint) break;
      await sleep(25);
    }
    if (!checkpoint)
      throw new Error('the gated HTTP checkpoint did not appear');
    const [{ pid }]: Array<{ pid: number }> = (await gate.query(
      'SELECT pg_backend_pid() AS pid',
    )) as Array<{ pid: number }>;
    await captureGatedPrefix(db, executionId, observed);
    while (!(await releaseEffect(token))) {
      if (Date.now() >= deadline)
        throw new Error('the receiver did not hold the gated HTTP response');
      await sleep(25);
    }
    const until = Date.now() + 3_000;
    while (Date.now() < until) {
      // pg_stat_activity кешує знімок у транзакції. У кожного спостереження окремий запит.
      if (await checkpointWriteIsBlocked(db, pid)) {
        log(`stopping postgres during write to checkpoint ${checkpoint}`);
        const started = Date.now();
        // SIGKILL не звільняє блокування бар’єра до переривання запису.
        docker([...COMPOSE, 'kill', '--signal', 'SIGKILL', 'postgres']);
        crashed = true;
        docker([...COMPOSE, 'start', 'postgres']);
        return { checkpoint, started };
      }
      await sleep(25);
    }
    throw new Error('the worker did not block on the gated HTTP checkpoint');
  } finally {
    // Після SIGKILL сесія вже відключена; на звичайній відмові відкат звільняє рядок.
    try {
      if (!crashed && gate.isTransactionActive)
        await gate.rollbackTransaction();
    } finally {
      try {
        await gate.release();
      } finally {
        await db.destroy();
      }
    }
  }
}

async function main(): Promise<void> {
  const before = await sinkStats();
  const workers = containers('worker');
  if (workers.length < 2)
    throw new Error(`need at least 2 running workers, found ${workers.length}`);
  const [postgres] = containers('postgres');
  const services = [...workers, ...containers('api')];
  const processes = new Map(services.map((id) => [id, processState(id)]));
  const since = new Date().toISOString();

  const started = Date.now();
  const ids: string[] = [];
  const interrupted: number[] = [];
  const observed = new Map<string, CheckpointObservation>();

  let downtimeMs = 0;
  for (let round = 0; round < RESTARTS; round++) {
    const token = randomUUID();
    const batch = await enqueueRound(round, RESTARTS, {
      token,
      beforeGatedRun: (running) => captureCheckpoints(running, observed, true),
    });
    ids.push(...batch);
    const { checkpoint, started: t0 } = await restartAtCheckpoint(
      batch[batch.length - 1],
      token,
      observed,
    );
    await waitHealthy([postgres], 60_000);
    downtimeMs += Date.now() - t0;
    log(`postgres is healthy again after ${Date.now() - t0} ms`);
    interrupted.push(await finishRound(batch, TIMEOUT_MS));
    const verification = await openDatabase();
    try {
      const [step]: { attempts: number; status: string }[] =
        await verification.query(
          'SELECT attempts, status FROM step_runs WHERE id=$1',
          [checkpoint],
        );
      if (step?.status !== 'succeeded' || step.attempts < 2)
        throw new Error(
          `round ${round + 1}: HTTP checkpoint ${checkpoint}, status=${step?.status ?? 'missing'}, attempts=${step?.attempts ?? 0}; expected succeeded after a retry`,
        );
    } finally {
      await verification.destroy();
    }
  }

  const db = await openDatabase();
  try {
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    const outcome = await collectOutcome(db, ids, before, observed);
    // Readiness воркерів і API залежить від БД: після відновлення вони мають знову бути healthy.
    await waitHealthy(services, 60_000);
    const restarted = services.filter(
      (id) => processState(id) !== processes.get(id),
    );
    const claimFailures = workers.reduce(
      (n, id) => n + countLogLines(id, since, 'job claim failed'),
      0,
    );
    const renewalFailures = workers.reduce(
      (n, id) => n + countLogLines(id, since, 'lease renewal failed'),
      0,
    );
    // Задача, що саме записувала результат кроку, коли БД зникла: запис не вдався, задачу поверне
    // reaper. Якщо перезапуск застав усі цикли за роботою, це єдиний слід збою в логах.
    const processingFailures = workers.reduce(
      (n, id) => n + countLogLines(id, since, 'job processing failed'),
      0,
    );
    finish(
      [
        `| Перезапусків Postgres | ${RESTARTS} (разом ${(downtimeMs / 1000).toFixed(1)} с до healthy) |`,
        `| Процесів воркерів і API, що перезапустились | ${restarted.length} з ${services.length} |`,
        `| Невдалих захоплень у логах воркерів (з backoff) | ${claimFailures} |`,
        `| Невдалих продовжень lease у логах воркерів | ${renewalFailures} |`,
        `| Задач, чий запис обірвався (job processing failed) | ${processingFailures} |`,
        `| Перерваних задач у кожному раунді | ${interrupted.join(' / ')} |`,
        ...outcomeRows(outcome, elapsed),
      ],
      [
        ...guaranteeProblems(outcome),
        ...interrupted.flatMap((count, round) =>
          count ? [] : [`round ${round + 1} did not interrupt a job`],
        ),
        ...restarted.map(
          (id) =>
            `container ${id.slice(0, 12)} was restarted: ${processes.get(id)} → ${processState(id)}`,
        ),
      ],
      'workers and API survived, every execution succeeded, one effect per Idempotency-Key',
    );
  } finally {
    await db.destroy();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
