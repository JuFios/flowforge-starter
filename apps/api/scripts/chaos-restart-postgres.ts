/**
 * Chaos-сценарій: під навантаженням двічі перезапускає Postgres (`docker compose restart postgres`)
 * і перевіряє, що воркери й API пережили це без перезапуску процесів, кожне виконання
 * завершилось, жоден завершений крок не виконано вдруге, а зовнішній ефект кожного http-кроку
 * стався рівно один раз (один ефект на Idempotency-Key).
 *
 * Запуск (з apps/api, стек з оверлеєм docker-compose.chaos.yml уже піднято — див. README):
 *   npm run chaos:postgres
 * Налаштування — див. chaos-common.ts.
 */
import { spawnSync } from 'node:child_process';
import {
  captureCheckpoints,
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
    const batch = await enqueueRound(round, RESTARTS);
    ids.push(...batch);
    await sleep(750);
    await captureCheckpoints(batch, observed);
    const observation = await openDatabase();
    let checkpoint: string;
    try {
      const rows: { id: string }[] = await observation.query(
        `SELECT id FROM step_runs WHERE "executionId"=ANY($1)
           AND "stepId"='charge' AND status='running' LIMIT 1`,
        [batch],
      );
      if (!rows.length) throw new Error('no active HTTP checkpoint');
      checkpoint = rows[0].id;
    } finally {
      await observation.destroy();
    }
    log('restarting postgres');
    const t0 = Date.now();
    docker([...COMPOSE, 'restart', 'postgres']);
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
      if (step.status !== 'succeeded' || step.attempts < 2)
        throw new Error(
          `round ${round + 1}: observed HTTP checkpoint did not retry and succeed`,
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
