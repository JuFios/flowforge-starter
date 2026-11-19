import { DataSource } from 'typeorm';
import { WorkerModule } from '../../src/app.module';
import { OutboxSender } from '../../src/outbox/outbox-sender.service';
import { SchedulerService } from '../../src/scheduler/scheduler.service';
import { RunningApp, startApp } from '../helpers/app';
import {
  createExecution,
  createTenant,
  createWorkflow,
  openTestDataSource,
  TestTenant,
  truncateAll,
} from '../helpers/db';
import { NotificationsService } from '../../src/notifications/notifications.service';
import { fakeTenantDb } from '../helpers/fake-tenant-db';
import { waitForBlocked } from '../helpers/transaction-barrier';

import { verifyNotification } from '../helpers/notifications';
import { api, Receiver } from '../helpers/queue';
import { testApiDatabaseUrl } from '../helpers/test-env';

/**
 * Налаштування сповіщень тенанта (ТЗ 3.3.9, 4): секрет показується один раз, ротація без простою,
 * зміна адреси, пауза й скасування для подій, що вже чекають; ізоляція тенантів у API і в БД;
 * секрети не потрапляють у відповіді, логи й метрики.
 */
describe('notification settings', () => {
  let ds: DataSource;
  let apiApp: RunningApp;
  let worker: RunningApp;
  let sender: OutboxSender;
  const receiver = new Receiver();
  let a: TestTenant;
  let b: TestTenant;

  beforeAll(async () => {
    ds = await openTestDataSource();
    await receiver.start();
    apiApp = await startApp(undefined, { captureLogs: true });
    apiApp.app.get(SchedulerService).onApplicationShutdown();
    worker = await startApp(WorkerModule, { captureLogs: true });
    sender = worker.app.get(OutboxSender);
  });
  beforeEach(async () => {
    await truncateAll(ds);
    receiver.requests.length = 0;
    a = await createTenant(ds, 'a');
    b = await createTenant(ds, 'b');
  });
  afterAll(async () => {
    await worker.close();
    await apiApp.close();
    await receiver.stop();
    await truncateAll(ds);
    await ds.destroy();
  });

  const call = <T = Record<string, unknown>>(
    tenant: TestTenant,
    method: string,
    path: string,
    body?: unknown,
  ) => api<T>(apiApp.baseUrl, tenant.apiKey, method, path, body);

  async function setup(tenant: TestTenant, path = '/notify') {
    const res = await fetch(`${apiApp.baseUrl}/tenants/me/notifications`, {
      method: 'PUT',
      headers: {
        'x-api-key': tenant.apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ url: receiver.url(path) }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    return (await res.json()) as {
      secret: string;
      keys: Array<{ id: string; role: string }>;
    };
  }

  /** Завершене виконання тенанта → подія в outbox. */
  async function completed(tenant: TestTenant): Promise<string> {
    const wf = await createWorkflow(ds, tenant.tenant.id);
    const execution = await createExecution(ds, wf);
    await ds.query(
      `UPDATE executions SET status = 'succeeded', "finishedAt" = now() WHERE id = $1`,
      [execution.id],
    );
    const [event]: Array<{ id: string }> = await ds.query(
      'SELECT id FROM outbox_events WHERE "executionId" = $1',
      [execution.id],
    );
    return event.id;
  }

  async function status(id: string): Promise<string> {
    const rows: Array<{ status: string }> = await ds.query(
      'SELECT status FROM outbox_events WHERE id = $1',
      [id],
    );
    return rows[0].status;
  }

  it.each(['delete first', 'completion first'])(
    'serializes terminal events with removal: %s',
    async (order) => {
      await setup(a, '/old');
      const wf = await createWorkflow(ds, a.tenant.id);
      const execution = await createExecution(ds, wf);
      const terminal = "UPDATE executions SET status='succeeded' WHERE id=$1";
      const holder = ds.createQueryRunner();
      await holder.connect();
      await holder.startTransaction();
      let waiting: Promise<unknown> | undefined;
      try {
        if (order === 'delete first') {
          // Штатний сервіс завершує видалення, а COMMIT контролює тест.
          await new NotificationsService(fakeTenantDb(holder.manager)).remove(
            a.tenant.id,
          );
          waiting = ds.query(terminal, [execution.id]);
        } else {
          await holder.query(terminal, [execution.id]);
          waiting = call(a, 'DELETE', '/tenants/me/notifications');
        }
        await waitForBlocked(ds, holder);
        await holder.commitTransaction();
        await waiting;
      } finally {
        if (holder.isTransactionActive) await holder.rollbackTransaction();
        await waiting;
        await holder.release();
      }
      await setup(a, '/new');
      const fresh = await completed(a);
      expect(await sender.deliverNext()).toBe(true);
      expect(
        receiver.hits('/new').map((req) => req.headers['x-flowforge-event-id']),
      ).toEqual([fresh]);
      expect(await sender.deliverNext()).toBe(false);
      expect(
        await ds.query(
          'SELECT status FROM outbox_events WHERE "executionId"=$1',
          [execution.id],
        ),
      ).toEqual(order === 'delete first' ? [] : [{ status: 'cancelled' }]);
    },
  );

  it.each(['/first', '/second'])(
    'serializes concurrent initial PUTs ending at %s',
    async (secondPath) => {
      const holder = ds.createQueryRunner();
      await holder.connect();
      await holder.startTransaction();
      const put = (path: string) =>
        call<{
          secret?: string;
          url: string;
          revision: number;
          keys: Array<{ id: string }>;
        }>(a, 'PUT', '/tenants/me/notifications', { url: receiver.url(path) });
      try {
        // SHARE пропускає пошук FOR NO KEY UPDATE, утримуючи обидві вставки до COMMIT.
        await holder.query('LOCK TABLE notification_settings IN SHARE MODE');
        const results = Promise.all([put('/first'), put(secondPath)]);
        await waitForBlocked(ds, holder, 2);
        await holder.commitTransaction();
        const responses = await results;
        expect(responses.map((r) => r.status)).toEqual([200, 200]);
        const creator = responses.filter((r) => r.body.secret);
        expect(creator).toHaveLength(1);
        expect(responses[0].body.keys).toEqual(responses[1].body.keys);
        const last = responses.find((r) => !r.body.secret)!;
        expect(
          await ds.query(
            'SELECT url, revision FROM notification_settings WHERE "tenantId"=$1',
            [a.tenant.id],
          ),
        ).toEqual([
          { url: last.body.url, revision: secondPath === '/first' ? 1 : 2 },
        ]);
      } finally {
        if (holder.isTransactionActive) await holder.rollbackTransaction();
        await holder.release();
      }
    },
  );

  it('shows the signing secret once and never again', async () => {
    const created = await setup(a);
    expect(created.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(created.keys).toEqual([
      { id: expect.any(String) as unknown, role: 'current' },
    ]);
    const read = await call(a, 'GET', '/tenants/me/notifications');
    expect(read.status).toBe(200);
    expect(read.body).toEqual({
      url: receiver.url('/notify'),
      enabled: true,
      revision: 1,
      keys: created.keys,
    });
    const updated = await call(a, 'PUT', '/tenants/me/notifications', {
      url: receiver.url('/other'),
    });
    expect(updated.body).not.toHaveProperty('secret');
    expect(updated.body).toMatchObject({ revision: 2 });
    expect(JSON.stringify([read.body, updated.body])).not.toContain(
      created.secret,
    );
  });

  it.each([
    ['plain http to another host', 'http://example.com/hook'],
    ['credentials in the URL', 'https://user:pass@example.com/hook'],
    ['a private address', 'https://10.0.0.5/hook'],
    ['the cloud metadata address', 'https://169.254.169.254/latest'],
    ['loopback by name', 'https://localhost/hook'],
    ['another scheme', 'ftp://example.com/hook'],
    ['not a URL', 'not a url'],
    ['an overly long URL', `https://example.com/${'a'.repeat(2050)}`],
  ])('rejects %s with 400 and stores nothing', async (_case, url) => {
    const res = await call(a, 'PUT', '/tenants/me/notifications', { url });
    expect(res.status).toBe(400);
    expect(await ds.query('SELECT 1 FROM notification_settings')).toEqual([]);
  });

  it.each([
    [{ url: 'https://example.com', enabled: 'yes' }],
    [{ url: 'https://example.com', secret: 'mine' }],
    [{}],
  ])('rejects the malformed body %j with 400', async (body) => {
    const res = await call(a, 'PUT', '/tenants/me/notifications', body);
    expect(res.status).toBe(400);
  });

  it('rotates without downtime: both keys sign pending events until the old one is revoked', async () => {
    const created = await setup(a);
    const rotated = await call<{ id: string; secret: string }>(
      a,
      'POST',
      '/tenants/me/notifications/secrets',
    );
    expect(rotated.status).toBe(201);
    expect(
      (await call(a, 'POST', '/tenants/me/notifications/secrets')).status,
    ).toBe(409);
    await completed(a);
    await sender.deliverNext();
    const [during] = receiver.hits('/notify');
    // Отримувач зі старим і з новим секретом однаково перевіряє підпис.
    expect(verifyNotification(during.headers, during.raw, created.secret)).toBe(
      true,
    );
    expect(
      verifyNotification(during.headers, during.raw, rotated.body.secret),
    ).toBe(true);
    expect(
      (
        await call(
          a,
          'DELETE',
          `/tenants/me/notifications/secrets/${created.keys[0].id}`,
        )
      ).status,
    ).toBe(204);
    await completed(a);
    await sender.deliverNext();
    const after = receiver.hits('/notify')[1];
    expect(verifyNotification(after.headers, after.raw, created.secret)).toBe(
      false,
    );
    expect(
      verifyNotification(after.headers, after.raw, rotated.body.secret),
    ).toBe(true);
    // Останній ключ не відкликається.
    expect(
      (
        await call(
          a,
          'DELETE',
          `/tenants/me/notifications/secrets/${rotated.body.id}`,
        )
      ).status,
    ).toBe(409);
    const attempts: Array<{ keyIds: string[] }> = await ds.query(
      'SELECT "keyIds" FROM outbox_attempts ORDER BY "startedAt"',
    );
    expect(attempts.map((r) => r.keyIds.length)).toEqual([2, 1]);
  });

  it('sends a pending event to the address that is current at the attempt', async () => {
    await setup(a, '/old');
    const event = await completed(a);
    // Подія вже чекає, коли тенант призупиняє сповіщення й переносить endpoint.
    await call(a, 'PUT', '/tenants/me/notifications', {
      url: receiver.url('/old'),
      enabled: false,
    });
    expect(await sender.deliverNext()).toBe(false);
    await call(a, 'PUT', '/tenants/me/notifications', {
      url: receiver.url('/new'),
      enabled: true,
    });
    expect(await sender.deliverNext()).toBe(true);
    expect(receiver.hits('/old')).toEqual([]);
    expect(receiver.hits('/new')).toHaveLength(1);
    expect(receiver.hits('/new')[0].headers['x-flowforge-event-id']).toBe(
      event,
    );
    const [attempt]: Array<{ revision: number }> = await ds.query(
      'SELECT revision FROM outbox_attempts WHERE "eventId" = $1',
      [event],
    );
    expect(attempt.revision).toBe(2);
  });

  it('pauses pending events while disabled and cancels them when the settings are deleted', async () => {
    await setup(a);
    await call(a, 'PUT', '/tenants/me/notifications', {
      url: receiver.url('/notify'),
      enabled: false,
    });
    // Вимкнено до завершення: події немає. Увімкнено після — подія є й чекає, поки знову вимкнуть.
    await call(a, 'PUT', '/tenants/me/notifications', {
      url: receiver.url('/notify'),
      enabled: true,
    });
    const event = await completed(a);
    await call(a, 'PUT', '/tenants/me/notifications', {
      url: receiver.url('/notify'),
      enabled: false,
    });
    expect(await sender.deliverNext()).toBe(false);
    expect(await status(event)).toBe('pending');
    expect((await call(a, 'DELETE', '/tenants/me/notifications')).status).toBe(
      204,
    );
    expect(await status(event)).toBe('cancelled');
    expect(receiver.requests).toEqual([]);
    // Подія лишається в журналі й доставляється повторно після нового налаштування.
    await setup(a);
    expect(
      (
        await call(
          a,
          'POST',
          `/tenants/me/notifications/events/${event}/redeliver`,
        )
      ).status,
    ).toBe(202);
    expect(await sender.deliverNext()).toBe(true);
    expect(await status(event)).toBe('delivered');
  });

  it('lists only the own events with their attempts and validates the page parameters', async () => {
    await setup(a);
    await setup(b);
    const own = await completed(a);
    const foreign = await completed(b);
    await sender.deliverNext();
    await sender.deliverNext();
    const list = await call<{ items: Array<{ id: string }>; nextCursor: null }>(
      a,
      'GET',
      '/tenants/me/notifications/events',
    );
    expect(list.body.items.map((e) => e.id)).toEqual([own]);
    expect(
      (await call(a, 'GET', `/tenants/me/notifications/events/${foreign}`))
        .status,
    ).toBe(404);
    expect(
      (
        await call(
          a,
          'POST',
          `/tenants/me/notifications/events/${foreign}/redeliver`,
        )
      ).status,
    ).toBe(404);
    const detail = await call<{ payload: string; attempts: unknown[] }>(
      a,
      'GET',
      `/tenants/me/notifications/events/${own}`,
    );
    expect(detail.body.attempts).toHaveLength(1);
    expect(JSON.parse(detail.body.payload)).toMatchObject({ id: own });
    for (const query of [
      'limit=abc',
      'limit=0',
      'limit=101',
      'limit=1.5',
      'status=lost',
      'cursor=garbage',
      'owner=b',
    ])
      expect(
        (await call(a, 'GET', `/tenants/me/notifications/events?${query}`))
          .status,
      ).toBe(400);
  });

  it('validates the UTC calendar of event cursors before querying', async () => {
    for (const [date, expected] of [
      ['2024-02-29T23:59:59', 200],
      ['2024-02-30T00:00:00', 400],
      ['2025-02-29T00:00:00', 400],
      ['2024-02-29T24:00:00', 400],
      ['0000-01-01T00:00:00', 400],
    ] as const) {
      const cursor = Buffer.from(`${date}.000000Z|${a.tenant.id}`).toString(
        'base64url',
      );
      expect(
        (
          await call(
            a,
            'GET',
            `/tenants/me/notifications/events?cursor=${cursor}`,
          )
        ).status,
      ).toBe(expected);
    }
  });

  it('keeps a delivered event and its attempts together while retention runs', async () => {
    await setup(a);
    const id = await completed(a);
    expect(await sender.deliverNext()).toBe(true);
    await ds.query(
      `UPDATE outbox_events SET "deliveredAt"=now()-interval '2 days' WHERE id=$1`,
      [id],
    );
    const purge = async () =>
      (
        await ds.query<Array<{ n: number }>>(
          'SELECT purge_delivered_events(1,1) AS n',
        )
      )[0].n;
    const reader = ds.createQueryRunner();
    await reader.connect();
    await reader.startTransaction();
    try {
      const query = reader.manager.query.bind(reader.manager);
      let purged: number | undefined;
      jest
        .spyOn(reader.manager, 'query')
        .mockImplementation(async (sql, params) => {
          if (sql.includes('FROM outbox_attempts')) purged = await purge();
          return query(sql, params);
        });
      const service = new NotificationsService(fakeTenantDb(reader.manager));
      const page = await service.eventPage(a.tenant.id, id, 1);
      expect(page.attempts.map((row) => row.attempt)).toEqual([1]);
      expect(purged).toBe(0);
      await reader.commitTransaction();
      expect(await purge()).toBe(1);
      expect(
        (await call(a, 'GET', `/tenants/me/notifications/events/${id}`)).status,
      ).toBe(404);
    } finally {
      if (reader.isTransactionActive) await reader.rollbackTransaction();
      await reader.release();
    }
  });

  it('bounds attempt pages and walks the original history across later deliveries', async () => {
    await setup(a);
    const id = await completed(a);
    const path = `/tenants/me/notifications/events/${id}`;
    const addAttempts = async (start: number, end: number) =>
      ds.transaction(async (em) => {
        await em.query(
          `INSERT INTO outbox_attempts ("tenantId","eventId",attempt,"senderId") SELECT $1,$2,g,'sender' FROM generate_series($3::int,$4::int) g`,
          [a.tenant.id, id, start, end],
        );
        await em.query('UPDATE outbox_events SET attempts=$2 WHERE id=$1', [
          id,
          end,
        ]);
      });
    type Page = {
      attempts: Array<{ attempt: number }>;
      nextAttemptsCursor: string | null;
    };
    await addAttempts(1, 101);
    const first = await call<Page>(a, 'GET', path + '?limit=100');
    expect(first.body.attempts).toHaveLength(100);
    expect(first.body.nextAttemptsCursor).toEqual(expect.any(String));
    await addAttempts(102, 102);
    const tail = await call<Page>(
      a,
      'GET',
      path + '?cursor=' + first.body.nextAttemptsCursor,
    );
    expect(tail.body.attempts.map((r) => r.attempt)).toEqual([101]);
    expect(tail.body.nextAttemptsCursor).toBeNull();
    expect((await call(a, 'GET', path + '?limit=101')).status).toBe(400);
    expect(
      (await call(b, 'GET', path + '?cursor=' + first.body.nextAttemptsCursor))
        .status,
    ).toBe(404);
    const another = await completed(a);
    expect(
      (
        await call(
          a,
          'GET',
          `/tenants/me/notifications/events/${another}?cursor=${first.body.nextAttemptsCursor}`,
        )
      ).status,
    ).toBe(400);
    const legacy = await call<Page>(a, 'GET', path);
    expect(legacy.body.attempts.map((r) => r.attempt)).toEqual(
      Array.from({ length: 102 }, (_, j) => j + 1),
    );
    expect(legacy.body).not.toHaveProperty('nextAttemptsCursor');
  });

  it('pages through events with a cursor without gaps or repeats', async () => {
    await setup(a);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await completed(a));
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: {
        body: { items: Array<{ id: string }>; nextCursor: string | null };
      } = await call(
        a,
        'GET',
        `/tenants/me/notifications/events?limit=2${cursor ? `&cursor=${cursor}` : ''}`,
      );
      seen.push(...page.body.items.map((e) => e.id));
      cursor = page.body.nextCursor;
    } while (cursor);
    expect([...seen].sort()).toEqual([...ids].sort());
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('keeps events created within the same millisecond on the pages', async () => {
    await setup(a);
    // Завершення під навантаженням: моменти створення різняться мікросекундами.
    await ds.query(
      `INSERT INTO outbox_events ("tenantId", "executionId", sequence, type, payload, "createdAt")
       SELECT $1, gen_random_uuid(), 1, 'execution.succeeded', '{}',
              '2026-11-19T10:00:00.123000Z'::timestamptz + make_interval(secs => g / 1000000.0)
         FROM generate_series(1, 6) g`,
      [a.tenant.id],
    );
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: {
        body: { items: Array<{ id: string }>; nextCursor: string | null };
      } = await call(
        a,
        'GET',
        `/tenants/me/notifications/events?limit=1${cursor ? `&cursor=${cursor}` : ''}`,
      );
      expect(page.body.items[0]).not.toHaveProperty('cursorAt');
      seen.push(...page.body.items.map((e) => e.id));
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
  });

  it('isolates the new tables in the database itself (RLS), not only in the services', async () => {
    await setup(a);
    await completed(a);
    await sender.deliverNext();
    const role = new DataSource({
      type: 'postgres',
      url: testApiDatabaseUrl(),
    });
    await role.initialize();
    try {
      for (const table of [
        'notification_settings',
        'outbox_events',
        'outbox_attempts',
      ]) {
        // Без контексту тенанта — нічого; у контексті B — нічого з рядків A.
        const unscoped: unknown[] = await role.query(`SELECT * FROM ${table}`);
        expect(unscoped).toEqual([]);
        const rows: unknown[] = await role.transaction(async (em) => {
          await em.query(`SELECT set_config('app.tenant_id', $1, true)`, [
            b.tenant.id,
          ]);
          return em.query(`SELECT * FROM ${table}`);
        });
        expect(rows).toEqual([]);
      }
      // Запис чужого рядка з контексту B відхиляє WITH CHECK.
      await expect(
        role.transaction(async (em) => {
          await em.query(`SELECT set_config('app.tenant_id', $1, true)`, [
            b.tenant.id,
          ]);
          await em.query(
            `INSERT INTO notification_settings ("tenantId", url, secret) VALUES ($1, 'https://x.example', $2)`,
            [a.tenant.id, 'f'.repeat(64)],
          );
        }),
      ).rejects.toThrow(/row-level security/);
    } finally {
      await role.destroy();
    }
  });

  it('keeps secrets out of logs, errors and metrics', async () => {
    const created = await setup(a);
    const rotated = await call<{ secret: string }>(
      a,
      'POST',
      '/tenants/me/notifications/secrets',
    );
    await completed(a);
    receiver.respond = (_req, res) => {
      res.writeHead(500).end();
    };
    await sender.deliverNext();
    const text = JSON.stringify([apiApp.logs, worker.logs]);
    for (const secret of [created.secret, rotated.body.secret])
      expect(text).not.toContain(secret);
    expect(text).not.toContain(receiver.url('/notify'));
  });
});
