/**
 * Chaos-сценарій сповіщень (docs/operations.md 3.3.9, «Chaos- і навантажувальні сценарії»): під час доставки
 * подій Postgres перезапускається, а отримувач (`sink`) губить підтвердження першої доставки
 * кожної події. Перевіряється, що кожне завершення дало рівно одну подію, кожна подія доставлена
 * (щонайменше двічі — після втраченого підтвердження) з тим самим ID і тими самими байтами,
 * підпис кожної доставки чинний, а кореляційний ID — той, з яким прийшов запит на запуск.
 *
 * Запуск (з apps/api, стек з оверлеєм docker-compose.chaos.yml уже піднято — див. README):
 *   npm run chaos:notifications
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  COMPOSE,
  docker,
  log,
  newKeyMaterial,
  openDatabase,
  rootEnv,
  sleep,
} from './chaos-common';

const API_URL = process.env.API_URL ?? 'http://localhost:3000';
const SINK_URL = process.env.SINK_URL ?? 'http://localhost:8080';
const RUNS = Number(process.env.CHAOS_NOTIFICATIONS ?? 50);
const TIMEOUT_MS = 180_000;

interface Delivery {
  id: string;
  attempt: string;
  timestamp: string;
  signature: string;
  requestId: string;
  body: string;
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

/** Перевірка підпису так, як її описує README для отримувача. */
function signed(d: Delivery, secret: string): boolean {
  const raw = Buffer.from(d.body, 'base64');
  const expected = createHmac('sha256', secret)
    .update(`v1\n${d.id}\n${d.timestamp}\n`)
    .update(raw)
    .digest();
  return d.signature.split(',').some((part) => {
    const v = part.trim();
    return (
      /^v1=[0-9a-f]{64}$/.test(v) &&
      timingSafeEqual(Buffer.from(v.slice(3), 'hex'), expected)
    );
  });
}

async function main(): Promise<void> {
  const apiKey = newKeyMaterial('ff_');
  await call(
    'POST',
    '/tenants',
    { 'x-admin-token': rootEnv('ADMIN_TOKEN') },
    {
      name: `chaos-notifications-${Date.now()}`,
      apiKey,
      webhookSecret: newKeyMaterial(),
    },
  );
  const auth = { 'x-api-key': apiKey };
  const secret = newKeyMaterial();
  await call('PUT', '/tenants/me/notifications', auth, {
    url: 'http://sink:8080/notifications',
    secret,
  });
  const wf = await call<{ id: string }>('POST', '/workflows', auth, {
    name: 'chaos-notifications',
    steps: [
      { id: 'start', type: 'log', message: 'n={{ input.n }}' },
      { id: 'wait', type: 'delay', ms: 500 },
    ],
  });
  log(`enqueueing ${RUNS} executions`);
  const runs = new Map<string, string>(); // executionId → x-request-id
  for (let n = 0; n < RUNS; n++) {
    const requestId = `chaos-notify-${n}`;
    const { id } = await call<{ id: string }>(
      'POST',
      `/workflows/${wf.id}/run`,
      { ...auth, 'x-request-id': requestId },
      { n },
    );
    runs.set(id, requestId);
  }
  const ids = [...runs.keys()];
  const counts = async () => {
    const db = await openDatabase();
    try {
      const [row]: Array<{ events: number; delivered: number }> =
        await db.query(
          `SELECT count(*)::int AS events,
                  (count(*) FILTER (WHERE status = 'delivered'))::int AS delivered
             FROM outbox_events WHERE "executionId" = ANY($1)`,
          [ids],
        );
      return row;
    } finally {
      await db.destroy();
    }
  };
  // Блокуємо конкретну подію з відкритою спробою. До рестарту ніхто не зможе
  // завершити її транзакцію доставки, навіть якщо HTTP-відповідь уже надійшла.
  const deadline = Date.now() + TIMEOUT_MS;
  const barrier = await openDatabase();
  const holder = barrier.createQueryRunner();
  try {
    await holder.startTransaction();
    for (;;) {
      const active = (await holder.query(
        `SELECT e.id, a.attempt FROM outbox_events e JOIN outbox_attempts a
          ON a."eventId"=e.id AND a.attempt=e.attempts
          WHERE e."executionId"=ANY($1) AND e.status='sending' AND a."finishedAt" IS NULL
          LIMIT 1 FOR UPDATE OF e SKIP LOCKED`,
        [ids],
      )) as Array<{ id: string; attempt: number }>;
      if (active.length) {
        log(
          `restarting postgres during attempt ${active[0].attempt} of event ${active[0].id}`,
        );
        docker([...COMPOSE, 'restart', 'postgres']);
        break;
      }
      if (Date.now() > deadline)
        throw new Error('no active delivery at restart barrier');
      await sleep(10);
    }
  } finally {
    await holder.release();
    await barrier.destroy();
  }
  for (;;) {
    let state: { events: number; delivered: number } | undefined;
    try {
      state = await counts();
    } catch {
      // БД ще піднімається.
    }
    if (state && state.delivered === RUNS && state.events === RUNS) break;
    if (Date.now() > deadline)
      throw new Error(
        `not every event was delivered in time: ${JSON.stringify(state)}`,
      );
    await sleep(1_000);
  }

  const db = await openDatabase();
  const problems: string[] = [];
  let attempts = 0;
  try {
    const events: Array<{
      id: string;
      executionId: string;
      payload: string;
      correlationId: string;
    }> = await db.query(
      `SELECT id, "executionId", payload, "correlationId" FROM outbox_events WHERE "executionId" = ANY($1)`,
      [ids],
    );
    const perExecution = new Map<string, number>();
    for (const e of events)
      perExecution.set(
        e.executionId,
        (perExecution.get(e.executionId) ?? 0) + 1,
      );
    if (
      events.length !== RUNS ||
      [...perExecution.values()].some((n) => n !== 1)
    )
      problems.push(`expected one event per execution, got ${events.length}`);
    const received = (await (
      await fetch(`${SINK_URL}/notifications`, {
        signal: AbortSignal.timeout(10000),
      })
    ).json()) as Delivery[];
    for (const e of events) {
      const hits = received.filter((d) => d.id === e.id);
      attempts += hits.length;
      if (hits.length < 2)
        problems.push(`event ${e.id} was received ${hits.length} times`);
      for (const h of hits) {
        if (
          !Buffer.from(h.body, 'base64').equals(Buffer.from(e.payload, 'utf8'))
        )
          problems.push(`event ${e.id} bytes differ between deliveries`);
        if (!signed(h, secret))
          problems.push(`event ${e.id} has an invalid signature`);
        if (h.requestId !== runs.get(e.executionId))
          problems.push(`event ${e.id} carries x-request-id ${h.requestId}`);
      }
      if (e.correlationId !== runs.get(e.executionId))
        problems.push(`event ${e.id} has correlationId ${e.correlationId}`);
    }
  } finally {
    await db.destroy();
  }
  console.log(
    [
      '| Метрика | Значення |',
      '|---|---|',
      `| Виконань | ${RUNS} |`,
      `| Подій (одна на виконання) | ${RUNS} |`,
      `| Доставок отримувачу (з втраченими підтвердженнями) | ${attempts} |`,
      `| Порушень | ${problems.length} |`,
    ].join('\n'),
  );
  if (problems.length) {
    for (const p of problems.slice(0, 20)) console.error(p);
    process.exit(1);
  }
  log('every event delivered with the same id and bytes, signed, traced');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
