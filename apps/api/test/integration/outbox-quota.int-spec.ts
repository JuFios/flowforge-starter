import { DataSource } from 'typeorm';
import { WorkerModule } from '../../src/app.module';
import { JobQueueService } from '../../src/engine/job-queue.service';
import { LimitsMetrics } from '../../src/limits/limits.metrics';
import { OutboxSender } from '../../src/outbox/outbox-sender.service';
import { SchedulerService } from '../../src/scheduler/scheduler.service';
import { OUTBOX_ATTEMPT_HISTORY } from '../../src/tenancy/limits';
import { RunningApp, startApp } from '../helpers/app';
import {
  createTenant,
  openTestDataSource,
  TestTenant,
  truncateAll,
} from '../helpers/db';
import { configureNotifications } from '../helpers/notifications';
import { Receiver, sleep, waitFor } from '../helpers/queue';

/**
 * Квота outbox (ТЗ 3.3.4, 3.3.9, 4): поки endpoint тенанта недоступний, недоставлені події разом
 * із живими виконаннями не перевищують `maxOutboxEvents`. Заповнена квота зупиняє лише нову
 * роботу цього тенанта (run, webhook, cron, retry, redeliver), а прийняті події лишаються й
 * доставляються; інший тенант працює далі. Історія спроб однієї події обмежена.
 */
describe('outbox quota', () => {
  let ds: DataSource;
  let api: RunningApp;
  let worker: RunningApp;
  let sender: OutboxSender;
  const receiver = new Receiver();
  let a: TestTenant;
  let b: TestTenant;

  beforeAll(async () => {
    ds = await openTestDataSource();
    await receiver.start();
    api = await startApp();
    api.app.get(SchedulerService).onApplicationShutdown();
    worker = await startApp(WorkerModule);
    sender = worker.app.get(OutboxSender);
  });
  beforeEach(async () => {
    await truncateAll(ds);
    receiver.requests.length = 0;
    // Endpoint тенанта недоступний.
    receiver.respond = (_req, res) => {
      res.writeHead(503).end();
    };
    a = await createTenant(ds, 'a');
    b = await createTenant(ds, 'b');
    for (const t of [a, b])
      await configureNotifications(api, t.apiKey, receiver.url('/notify'));
    api.app.get(LimitsMetrics).enqueueRejected.reset();
  });
  afterAll(async () => {
    await worker.close();
    await api.close();
    await receiver.stop();
    await truncateAll(ds);
    await ds.destroy();
  });

  const setQuota = (tenant: TestTenant, quota: number) =>
    ds.query('UPDATE tenants SET "maxOutboxEvents"=$2 WHERE id=$1', [
      tenant.tenant.id,
      quota,
    ]);

  function call(
    tenant: TestTenant,
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    return fetch(api.baseUrl + path, {
      method,
      headers: {
        'x-api-key': tenant.apiKey,
        'content-type': 'application/json',
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function workflow(tenant: TestTenant, extra = {}): Promise<string> {
    const res = await call(tenant, 'POST', '/workflows', {
      name: 'quota',
      steps: [{ id: 'say', type: 'log', message: 'hi' }],
      ...extra,
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }
  const run = (tenant: TestTenant, wf: string, key?: string) =>
    call(
      tenant,
      'POST',
      `/workflows/${wf}/run`,
      {},
      key ? { 'idempotency-key': key } : {},
    );

  /** Завершує всі живі виконання тенанта так, як воркер: кінцевий стан і задача done. */
  async function finishAll(tenant: TestTenant) {
    await ds.query(
      `UPDATE executions SET status='succeeded', "finishedAt"=now()
        WHERE "tenantId"=$1 AND status IN ('pending','running')`,
      [tenant.tenant.id],
    );
    await ds.query(
      `UPDATE jobs SET status='done', "finishedAt"=now() WHERE "tenantId"=$1 AND status<>'done'`,
      [tenant.tenant.id],
    );
  }

  /** Лічильник обліку дорівнює фактичній кількості недоставлених подій. */
  async function assertCounter(tenant: TestTenant) {
    const [row]: Array<{ counter: number; actual: number }> = await ds.query(
      `SELECT u.undelivered AS counter,
              (SELECT count(*)::int FROM outbox_events e
                WHERE e."tenantId"=u."tenantId" AND e.status IN ('pending','sending')) AS actual
         FROM tenant_outbox_usage u WHERE u."tenantId"=$1`,
      [tenant.tenant.id],
    );
    expect(row.counter).toBe(row.actual);
    return row.actual;
  }

  async function rejected(trigger: string): Promise<number> {
    const { values } = await api.app.get(LimitsMetrics).enqueueRejected.get();
    return (
      values.find(
        (v) =>
          v.labels.trigger === trigger && v.labels.reason === 'outbox_full',
      )?.value ?? 0
    );
  }

  it('lets a worker claim work for the same tenant while delivery holds the outbox counter', async () => {
    const wf = await workflow(a);
    expect((await run(a, wf)).status).toBe(201);
    await finishAll(a);
    expect(await assertCounter(a)).toBe(1);
    expect((await run(a, wf)).status).toBe(201);

    const delivery = ds.createQueryRunner();
    await delivery.connect();
    try {
      await delivery.startTransaction();
      await delivery.query(
        `UPDATE outbox_events SET status='delivered', "deliveredAt"=now()
          WHERE "tenantId"=$1 AND status='pending'`,
        [a.tenant.id],
      );
      const claimed = await worker.app.get(JobQueueService).claimNext('quota');
      expect(claimed).toMatchObject({ tenantId: a.tenant.id });
      await delivery.commitTransaction();
    } finally {
      if (delivery.isTransactionActive) await delivery.rollbackTransaction();
      await delivery.release();
    }
    expect(await assertCounter(a)).toBe(0);
  });

  it('takes the notification lock before changing job usage across a mixed reaper batch', async () => {
    const wf = await workflow(a);
    expect((await run(a, wf)).status).toBe(201);
    expect((await run(a, wf)).status).toBe(201);
    await ds.query(
      `WITH ordered AS (
         SELECT id, row_number() OVER (ORDER BY id) AS n FROM jobs WHERE "tenantId"=$1
       )
       UPDATE jobs j SET status='running', "lockToken"=gen_random_uuid(),
              "lockedBy"='lost', "lockedUntil"=now()-make_interval(secs => (3-n)::int),
              attempts=CASE n WHEN 1 THEN 1 ELSE j."maxAttempts" END
       FROM ordered WHERE j.id=ordered.id`,
      [a.tenant.id],
    );
    const settings = ds.createQueryRunner();
    await settings.connect();
    await settings.startTransaction();
    const [{ pid }] = (await settings.query(
      'SELECT pg_backend_pid() AS pid',
    )) as Array<{ pid: number }>;
    await settings.query(
      'SELECT 1 FROM notification_settings WHERE "tenantId"=$1 FOR UPDATE',
      [a.tenant.id],
    );
    const reaped = worker.app
      .get(JobQueueService)
      .reapExpired()
      .then(
        (jobs) => ({ jobs, error: undefined }),
        (error: unknown) => ({ jobs: [], error }),
      );
    try {
      await waitFor('reaper to wait for notification settings', async () => {
        const blocked: unknown[] = await ds.query(
          'SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',
          [pid],
        );
        return blocked.length > 0;
      });
      await settings.query(
        'SELECT 1 FROM tenant_usage WHERE "tenantId"=$1 FOR UPDATE NOWAIT',
        [a.tenant.id],
      );
    } finally {
      await settings.rollbackTransaction();
      await settings.release();
      await reaped;
    }
    const result = await reaped;
    expect(result.error).toBeUndefined();
    expect(result.jobs.map((job) => job.outcome)).toEqual(['retry', 'dead']);
    expect(await assertCounter(a)).toBe(1);
  });

  it('stops new work of the tenant whose endpoint is down and keeps every accepted event', async () => {
    await setQuota(a, 3);
    const wf = await workflow(a);
    const accepted = await run(a, wf, 'order-1');
    expect(accepted.status).toBe(201);
    for (let i = 0; i < 2; i++) expect((await run(a, wf)).status).toBe(201);
    // Живі виконання вже займають квоту: кожне завершиться подією.
    const full = await run(a, wf);
    expect(full.status).toBe(429);
    expect(await full.json()).toMatchObject({ error: 'outbox_full' });
    expect(full.headers.get('retry-after')).toBeNull();
    expect(await rejected('api')).toBe(1);

    await finishAll(a);
    expect(await assertCounter(a)).toBe(3);
    // Спроби доставки на недоступний endpoint подій не видаляють і місця не звільняють.
    while (await sender.deliverNext());
    expect(await assertCounter(a)).toBe(3);
    expect((await run(a, wf)).status).toBe(429);
    // Повтор прийнятого запиту повертає чинний результат і за повної квоти.
    expect((await run(a, wf, 'order-1')).status).toBe(200);

    // Інший тенант працює далі.
    expect((await run(b, await workflow(b))).status).toBe(201);

    // Endpoint знову приймає: доставка звільняє квоту.
    receiver.respond = (_req, res) => {
      res.writeHead(200).end();
    };
    await ds.query(
      `UPDATE outbox_events SET "nextAttemptAt"=now() WHERE "tenantId"=$1`,
      [a.tenant.id],
    );
    await ds.query(
      `UPDATE notification_settings SET "dueAt"=now() WHERE "tenantId"=$1`,
      [a.tenant.id],
    );
    while (await sender.deliverNext());
    expect(await assertCounter(a)).toBe(0);
    expect((await run(a, wf)).status).toBe(201);
  });

  it('admits exactly one of concurrent runs for the last free place', async () => {
    await setQuota(a, 4);
    const wf = await workflow(a);
    for (let i = 0; i < 3; i++) expect((await run(a, wf)).status).toBe(201);
    await finishAll(a);
    const statuses = (
      await Promise.all(Array.from({ length: 10 }, () => run(a, wf)))
    ).map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 429)).toHaveLength(9);
    await finishAll(a);
    expect(await assertCounter(a)).toBe(4);
  });

  it('applies the quota to retry, redeliver, cron and discard', async () => {
    await setQuota(a, 2);
    const wf = await workflow(a);
    const first = (await (await run(a, wf)).json()) as { id: string };
    expect((await run(a, wf)).status).toBe(201);
    await ds.query(
      `UPDATE executions SET status='failed', "finishedAt"=now(), error='x' WHERE id=$1`,
      [first.id],
    );
    await finishAll(a);
    expect(await assertCounter(a)).toBe(2);
    // /retry відкриває новий цикл — ще одна майбутня подія.
    const retry = await call(a, 'POST', `/executions/${first.id}/retry`);
    expect(retry.status).toBe(429);
    expect(await rejected('retry')).toBe(1);

    // Явна відмова звільняє місце.
    const discard = await call(
      a,
      'POST',
      '/tenants/me/notifications/events/discard',
    );
    expect(await discard.json()).toEqual({ discarded: 2 });
    expect(await assertCounter(a)).toBe(0);
    expect((await run(a, wf)).status).toBe(201);
    expect((await run(a, wf)).status).toBe(201);
    // Скасована подія знову стає недоставленою лише в межах квоти.
    const [cancelled]: Array<{ id: string }> = await ds.query(
      `SELECT id FROM outbox_events WHERE "tenantId"=$1 AND status='cancelled' LIMIT 1`,
      [a.tenant.id],
    );
    const redeliver = await call(
      a,
      'POST',
      `/tenants/me/notifications/events/${cancelled.id}/redeliver`,
    );
    expect(redeliver.status).toBe(429);
    expect(await redeliver.json()).toMatchObject({ error: 'outbox_full' });

    // Cron відкладає спрацювання, а не відкидає його.
    const scheduler = api.app.get(SchedulerService);
    const cron = await workflow(a, { cron: '* * * * * *' });
    await sleep(1_500);
    expect(await scheduler.tick()).toBe(0);
    const [blocked]: Array<{ since: Date | null }> = await ds.query(
      'SELECT "scheduleBlockedSince" AS since FROM workflows WHERE id=$1',
      [cron],
    );
    expect(blocked.since).not.toBeNull();
  });

  it('keeps the first and the latest attempts of an event within the history bound', async () => {
    const wf = await workflow(a);
    expect((await run(a, wf)).status).toBe(201);
    await finishAll(a);
    const [event]: Array<{ id: string }> = await ds.query(
      'SELECT id FROM outbox_events WHERE "tenantId"=$1',
      [a.tenant.id],
    );
    const total = OUTBOX_ATTEMPT_HISTORY + 15;
    for (let i = 0; i < total; i++) {
      await ds.query(
        `UPDATE outbox_events SET "nextAttemptAt"=now() WHERE id=$1`,
        [event.id],
      );
      await ds.query(
        `UPDATE notification_settings SET "dueAt"=now() WHERE "tenantId"=$1`,
        [a.tenant.id],
      );
      expect(await sender.deliverNext()).toBe(true);
    }
    const attempts: Array<{ attempt: number }> = await ds.query(
      'SELECT attempt FROM outbox_attempts WHERE "eventId"=$1 ORDER BY attempt',
      [event.id],
    );
    expect(attempts.map((r) => r.attempt)).toEqual([
      1,
      ...Array.from(
        { length: OUTBOX_ATTEMPT_HISTORY - 1 },
        (_, i) => total - OUTBOX_ATTEMPT_HISTORY + 2 + i,
      ),
    ]);
    const [{ attempts: counted }]: Array<{ attempts: number }> = await ds.query(
      'SELECT attempts FROM outbox_events WHERE id=$1',
      [event.id],
    );
    expect(counted).toBe(total);
    expect(await assertCounter(a)).toBe(1);
  });
});
