/**
 * Chaos-сценарій: під навантаженням вбиває воркери (SIGKILL, без graceful shutdown) і
 * перевіряє, що кожне виконання завершилось, жоден завершений крок не виконано вдруге, а
 * зовнішній ефект кожного http-кроку стався рівно один раз.
 *
 * Запуск (з apps/api, стек з оверлеєм docker-compose.chaos.yml уже піднято — див. README):
 *   npm run chaos
 * Налаштування — див. chaos-common.ts.
 */
import {
  captureCheckpoints,
  CheckpointObservation,
  collectOutcome,
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

async function main(): Promise<void> {
  // Лічильники отримувача накопичуються між запусками: рахуємо приріст за цей запуск.
  const before = await sinkStats();
  const workers = containers('worker');
  if (workers.length < 2)
    throw new Error(`need at least 2 running workers, found ${workers.length}`);

  const started = Date.now();
  const ids: string[] = [];
  const interrupted: number[] = [];
  const observed = new Map<string, CheckpointObservation>();

  // Два раунди: вбити воркер посеред роботи, дати іншим працювати, підняти його знову.
  const kills: string[] = [];
  for (const [round, victim] of workers.slice(0, 2).entries()) {
    const batch = await enqueueRound(round, 2);
    ids.push(...batch);
    await sleep(750);
    await captureCheckpoints(batch, observed);
    log(`SIGKILL worker ${victim.slice(0, 12)}`);
    docker(['kill', '--signal', 'KILL', victim]);
    kills.push(victim.slice(0, 12));
    await sleep(3_000);
    log(`restarting worker ${victim.slice(0, 12)}`);
    docker(['start', victim]);
    interrupted.push(await finishRound(batch, TIMEOUT_MS));
  }

  const db = await openDatabase();
  try {
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    const outcome = await collectOutcome(db, ids, before, observed);
    finish(
      [
        `| Убито воркерів (SIGKILL) | ${kills.length} (${kills.join(', ')}) |`,
        `| Перерваних задач у кожному раунді | ${interrupted.join(' / ')} |`,
        ...outcomeRows(outcome, elapsed),
      ],
      [
        ...guaranteeProblems(outcome),
        ...interrupted.flatMap((count, round) =>
          count ? [] : [`round ${round + 1} did not interrupt a job`],
        ),
      ],
      'every execution succeeded, no completed step re-ran, one effect per http step',
    );
  } finally {
    await db.destroy();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
