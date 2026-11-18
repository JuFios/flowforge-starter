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
  collectOutcome,
  COMPOSE,
  containers,
  docker,
  enqueueWorkload,
  finish,
  guaranteeProblems,
  log,
  openDatabase,
  outcomeRows,
  sinkStats,
  sleep,
  waitUntilFinished,
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
  const ids = await enqueueWorkload();

  let downtimeMs = 0;
  for (let round = 0; round < RESTARTS; round++) {
    await sleep(round === 0 ? 2_000 : 4_000);
    log('restarting postgres');
    const t0 = Date.now();
    docker([...COMPOSE, 'restart', 'postgres']);
    await waitHealthy([postgres], 60_000);
    downtimeMs += Date.now() - t0;
    log(`postgres is healthy again after ${Date.now() - t0} ms`);
  }

  const db = await openDatabase();
  try {
    await waitUntilFinished(db, ids, TIMEOUT_MS);
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    const outcome = await collectOutcome(db, ids, before);
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

    finish(
      [
        `| Перезапусків Postgres | ${RESTARTS} (разом ${(downtimeMs / 1000).toFixed(1)} с до healthy) |`,
        `| Процесів воркерів і API, що перезапустились | ${restarted.length} з ${services.length} |`,
        `| Невдалих захоплень у логах воркерів (з backoff) | ${claimFailures} |`,
        `| Невдалих продовжень lease у логах воркерів | ${renewalFailures} |`,
        ...outcomeRows(outcome, elapsed),
      ],
      [
        ...guaranteeProblems(outcome),
        ...restarted.map(
          (id) =>
            `container ${id.slice(0, 12)} was restarted: ${processes.get(id)} → ${processState(id)}`,
        ),
        ...(claimFailures + renewalFailures === 0
          ? [
              'workers never saw the database outage: the scenario proved nothing, run it again',
            ]
          : []),
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
