import { DataSource } from 'typeorm';
import { SchedulerService } from '../../src/scheduler/scheduler.service';
import { RunningApp } from './app';

/** Поточний час за годинником БД — спільним для всіх інстансів планувальника. */
export async function dbNow(ds: DataSource): Promise<Date> {
  const [row]: Array<{ now: Date }> = await ds.query(
    'SELECT clock_timestamp() AS now',
  );
  return row.now;
}

/** Заплановані моменти виконань workflow за зростанням (мс від епохи). */
export async function scheduledTimes(
  ds: DataSource,
  workflowId: string,
): Promise<number[]> {
  const rows: Array<{ at: Date }> = await ds.query(
    `SELECT "scheduledAt" AS at FROM executions
      WHERE "workflowId" = $1 AND "scheduledAt" IS NOT NULL ORDER BY "scheduledAt"`,
    [workflowId],
  );
  return rows.map((r) => r.at.getTime());
}

/** Цілі секунди s, для яких from < s ≤ to (моменти розкладу `* * * * * *`). */
export function wholeSeconds(from: Date, to: Date): number[] {
  const out: number[] = [];
  for (
    let s = Math.floor(from.getTime() / 1000) * 1000 + 1000;
    s <= to.getTime();
    s += 1000
  )
    out.push(s);
  return out;
}

/** Зупиняє власний таймер планувальника: тест сам вирішує, коли настає тік. */
export function stopSchedulerTimer(app: RunningApp): SchedulerService {
  const scheduler = app.app.get(SchedulerService);
  scheduler.onApplicationShutdown();
  return scheduler;
}

/** Запит до API від імені тенанта. */
export function tenantCall(
  app: RunningApp,
  apiKey: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${app.baseUrl}${path}`, {
    method,
    headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Створює workflow через API; повертає id і момент створення за годинником БД. */
export async function createScheduledWorkflow(
  app: RunningApp,
  ds: DataSource,
  apiKey: string,
  fields: Record<string, unknown>,
): Promise<{ id: string; createdAt: Date }> {
  const res = await tenantCall(app, apiKey, 'POST', '/workflows', {
    name: 'scheduled',
    steps: [{ id: 'say', type: 'log', message: 'tick' }],
    ...fields,
  });
  if (res.status !== 201)
    throw new Error(`POST /workflows → ${res.status}: ${await res.text()}`);
  const { id } = (await res.json()) as { id: string };
  const [row]: Array<{ createdAt: Date }> = await ds.query(
    'SELECT "createdAt" FROM workflows WHERE id = $1',
    [id],
  );
  return { id, createdAt: row.createdAt };
}
