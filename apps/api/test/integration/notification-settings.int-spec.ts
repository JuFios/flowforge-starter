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
import { TenantDb } from '../../src/tenancy/tenant-db';
import { fakeTenantDb } from '../helpers/fake-tenant-db';
import { waitForBlocked } from '../helpers/transaction-barrier';
import { waitFor } from '../helpers/wait-for';

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
      // Завершення після видалення — без налаштувань подія не приймається; прийнята до видалення
      // подія чекає й доходить до наступного endpoint-а тенанта без ручного redeliver.
      const accepted: Array<{ id: string }> = await ds.query(
        'SELECT id FROM outbox_events WHERE "executionId"=$1',
        [execution.id],
      );
      expect(accepted).toHaveLength(order === 'delete first' ? 0 : 1);
      await setup(a, '/new');
      const fresh = await completed(a);
      while (await sender.deliverNext());
      expect(
        receiver
          .hits('/new')
          .map((req) => req.headers['x-flowforge-event-id'])
          .sort(),
      ).toEqual([...accepted.map((e) => e.id), fresh].sort());
      expect(receiver.hits('/old')).toEqual([]);
      for (const e of accepted) expect(await status(e.id)).toBe('delivered');
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
      let next: ReturnType<typeof put> | undefined;
      try {
        // Перше налаштування тримає запобіжний рядок тенанта до COMMIT.
        const settings = new NotificationsService(fakeTenantDb(holder.manager));
        const first = await settings.put(a.tenant.id, {
          url: receiver.url('/first'),
        });
        next = put(secondPath);
        await waitForBlocked(ds, holder);
        await holder.commitTransaction();
        const last = await next;
        expect(last.status).toBe(200);
        expect(first.secret).toEqual(expect.any(String));
        expect(last.body.secret).toBeUndefined();
        expect(last.body.keys).toEqual(first.keys);
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
        await next?.catch(() => undefined);
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

  it('pauses a claimed event when the settings are deleted and delivers it after the next setup', async () => {
    await setup(a, '/old');
    const id = await completed(a);
    const [claimed]: Array<{ leaseToken: string }> = await ds.query(
      `SELECT "leaseToken" FROM claim_outbox_event('lost', 30000, 1)`,
    );
    expect(await status(id)).toBe('sending');
    expect((await call(a, 'DELETE', '/tenants/me/notifications')).status).toBe(
      204,
    );
    expect(await status(id)).toBe('pending');
    expect(
      await ds.query(
        'SELECT outcome, "finishedAt" IS NOT NULL AS finished FROM outbox_attempts WHERE "eventId"=$1',
        [id],
      ),
    ).toEqual([{ outcome: 'paused', finished: true }]);
    // Пізній результат спроби, що тривала, нічого не змінює: fencing-токен скинуто.
    const [late]: Array<{ applied: boolean }> = await ds.query(
      `SELECT finish_outbox_event($1, $2, 0, 'delivered', 200) AS applied`,
      [id, claimed.leaseToken],
    );
    expect(late.applied).toBe(false);
    expect(await sender.deliverNext()).toBe(false);
    const [before]: Array<{ payload: string }> = await ds.query(
      'SELECT payload FROM outbox_events WHERE id=$1',
      [id],
    );
    await setup(a, '/new');
    expect(await sender.deliverNext()).toBe(true);
    const [hit] = receiver.hits('/new');
    expect(hit.headers['x-flowforge-event-id']).toBe(id);
    expect(hit.raw.toString()).toBe(before.payload);
    expect(await status(id)).toBe('delivered');
  });

  it('keeps accepting events while paused and delivers them once enabled', async () => {
    await setup(a);
    await call(a, 'PUT', '/tenants/me/notifications', {
      url: receiver.url('/notify'),
      enabled: false,
    });
    // Пауза зупиняє доставку, а не приймання: завершення під час паузи теж дає подію.
    const during = await completed(a);
    expect(await sender.deliverNext()).toBe(false);
    expect(await status(during)).toBe('pending');
    expect(receiver.requests).toEqual([]);
    await call(a, 'PUT', '/tenants/me/notifications', {
      url: receiver.url('/notify'),
      enabled: true,
    });
    expect(await sender.deliverNext()).toBe(true);
    expect(await status(during)).toBe('delivered');
  });

  it('cancels undelivered events only on the explicit request of the tenant', async () => {
    await setup(a);
    await setup(b);
    const first = await completed(a);
    const second = await completed(a);
    const other = await completed(b);
    expect((await call(a, 'DELETE', '/tenants/me/notifications')).status).toBe(
      204,
    );
    expect(await status(first)).toBe('pending');
    const res = await call<{ discarded: number }>(
      a,
      'POST',
      '/tenants/me/notifications/events/discard',
    );
    expect(res).toEqual({ status: 200, body: { discarded: 2 } });
    expect([await status(first), await status(second)]).toEqual([
      'cancelled',
      'cancelled',
    ]);
    // Відмова тенанта A не зачіпає подій тенанта B.
    expect(await status(other)).toBe('pending');
    await call(b, 'DELETE', '/tenants/me/notifications');
    // Після нового налаштування відмовлені події не надсилаються; redeliver повертає одну з них.
    await setup(a);
    expect(await sender.deliverNext()).toBe(false);
    expect(
      (
        await call(
          a,
          'POST',
          `/tenants/me/notifications/events/${first}/redeliver`,
        )
      ).status,
    ).toBe(202);
    expect(await sender.deliverNext()).toBe(true);
    expect(await status(first)).toBe('delivered');
    expect(await status(second)).toBe('cancelled');
    expect(receiver.requests).toHaveLength(1);
  });

  it('preserves an event requeued after it passed an earlier discard batch', async () => {
    const tenantId = a.tenant.id;
    const [{ id }] = await ds.query<Array<{ id: string }>>(
      `WITH seeded AS (
         INSERT INTO outbox_events ("tenantId", "executionId", sequence, type, payload, "createdAt")
         SELECT $1, gen_random_uuid(), 1, 'execution.succeeded', '{}',
                TIMESTAMPTZ '2020-01-01 00:00:00.000001+00'
                  + LEAST(n, 1) * interval '1 microsecond'
           FROM generate_series(0, 1000) n
         RETURNING id, "createdAt"
       ) SELECT id FROM seeded ORDER BY "createdAt", id LIMIT 1`,
      [tenantId],
    );
    const db = apiApp.app.get(TenantDb);
    const notifications = apiApp.app.get(NotificationsService);
    const run = db.run.bind(db);
    let transactions = 0;
    const barrier = jest
      .spyOn(db, 'run')
      .mockImplementation(async (context, fn) => {
        const result = await run(context, fn);
        // Перший виклик фіксує час, другий комітить першу порцію.
        if (++transactions === 2) await notifications.redeliver(tenantId, id);
        return result;
      });
    try {
      expect(await notifications.discard(tenantId)).toEqual({
        discarded: 1001,
      });
      expect(await status(id)).toBe('pending');
    } finally {
      barrier.mockRestore();
    }
  });

  it('keeps an event inserted after the first discard batch by an older transaction', async () => {
    await setup(a);
    const tenantId = a.tenant.id;
    await ds.query(
      `INSERT INTO outbox_events ("tenantId", "executionId", sequence, type, payload)
       SELECT $1, gen_random_uuid(), 1, 'execution.succeeded', '{}'
       FROM generate_series(1, 1001)`,
      [tenantId],
    );
    const execution = await createExecution(
      ds,
      await createWorkflow(ds, tenantId),
    );
    const completion = ds.createQueryRunner();
    await completion.connect();
    await completion.startTransaction();
    const db = apiApp.app.get(TenantDb);
    const run = db.run.bind(db);
    let transactions = 0;
    const barrier = jest
      .spyOn(db, 'run')
      .mockImplementation(async (context, fn) => {
        const result = await run(context, fn);
        if (++transactions === 2) {
          await completion.query(
            `UPDATE executions SET status = 'succeeded', "finishedAt" = now() WHERE id = $1`,
            [execution.id],
          );
          await completion.commitTransaction();
        }
        return result;
      });
    try {
      expect(
        await apiApp.app.get(NotificationsService).discard(tenantId),
      ).toEqual({
        discarded: 1001,
      });
      expect(
        await ds.query(
          'SELECT status FROM outbox_events WHERE "executionId" = $1',
          [execution.id],
        ),
      ).toEqual([{ status: 'pending' }]);
    } finally {
      barrier.mockRestore();
      if (completion.isTransactionActive)
        await completion.rollbackTransaction();
      await completion.release();
    }
  });

  it('delivers a redelivery racing with creation of new settings', async () => {
    await setup(a, '/old');
    const id = await completed(a);
    expect(await sender.deliverNext()).toBe(true);
    expect((await call(a, 'DELETE', '/tenants/me/notifications')).status).toBe(
      204,
    );

    const holder = ds.createQueryRunner();
    await holder.connect();
    await holder.startTransaction();
    let replay: Promise<{ status: number }> | undefined;
    try {
      const settings = new NotificationsService(fakeTenantDb(holder.manager));
      await settings.put(a.tenant.id, { url: receiver.url('/new') });
      const [{ pid }] = (await holder.query(
        'SELECT pg_backend_pid() AS pid',
      )) as Array<{ pid: number }>;
      let settled = false;
      replay = call(
        a,
        'POST',
        `/tenants/me/notifications/events/${id}/redeliver`,
      );
      void replay.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await waitFor(
        'redelivery to complete or wait for recreation',
        async () => {
          if (settled) return true;
          const [{ blocked }] = await ds.query<Array<{ blocked: boolean }>>(
            'SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS blocked',
            [pid],
          );
          return blocked;
        },
      );
      await holder.commitTransaction();
      expect((await replay).status).toBe(202);
    } finally {
      if (holder.isTransactionActive) await holder.rollbackTransaction();
      await replay;
      await holder.release();
    }
    expect(await sender.deliverNext()).toBe(true);
    expect(await status(id)).toBe('delivered');
    expect(receiver.hits('/new')).toHaveLength(1);
  });

  it('delivers a paused attempt when settings are recreated concurrently with removal', async () => {
    await setup(a, '/old');
    const id = await completed(a);
    await ds.query(`SELECT id FROM claim_outbox_event('lost', 30000, 1)`);
    expect(await status(id)).toBe('sending');

    const holder = ds.createQueryRunner();
    await holder.connect();
    await holder.startTransaction();
    let put: Promise<{ status: number }> | undefined;
    try {
      const settings = new NotificationsService(fakeTenantDb(holder.manager));
      await settings.remove(a.tenant.id);
      put = call(a, 'PUT', '/tenants/me/notifications', {
        url: receiver.url('/new'),
      });
      await waitForBlocked(ds, holder);
      await holder.commitTransaction();
      expect((await put).status).toBe(200);
    } finally {
      if (holder.isTransactionActive) await holder.rollbackTransaction();
      await put;
      await holder.release();
    }
    expect(await sender.deliverNext()).toBe(true);
    expect(await status(id)).toBe('delivered');
    expect(receiver.hits('/new')).toHaveLength(1);
  });

  it('discards a pending event while its details are being read', async () => {
    await setup(a);
    const id = await completed(a);
    const reader = ds.createQueryRunner();
    await reader.connect();
    await reader.startTransaction();
    try {
      const settings = new NotificationsService(fakeTenantDb(reader.manager));
      await settings.eventPage(a.tenant.id, id, 10);
      const response = await call<{ discarded: number }>(
        a,
        'POST',
        '/tenants/me/notifications/events/discard',
      );
      expect(response).toEqual({ status: 200, body: { discarded: 1 } });
      expect(await status(id)).toBe('cancelled');
    } finally {
      await reader.rollbackTransaction();
      await reader.release();
    }
  });

  it('accepts a redelivery without settings and sends it after the next setup', async () => {
    await setup(a);
    const id = await completed(a);
    expect(await sender.deliverNext()).toBe(true);
    expect((await call(a, 'DELETE', '/tenants/me/notifications')).status).toBe(
      204,
    );
    expect(
      (
        await call(
          a,
          'POST',
          `/tenants/me/notifications/events/${id}/redeliver`,
        )
      ).status,
    ).toBe(202);
    expect(await status(id)).toBe('pending');
    expect(await sender.deliverNext()).toBe(false);
    await setup(a);
    expect(await sender.deliverNext()).toBe(true);
    expect(receiver.requests).toHaveLength(2);
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
    // Історія спроб обмежена (OUTBOX_ATTEMPT_HISTORY = 20): перша й останні 19.
    await addAttempts(1, 30);
    const first = await call<Page>(a, 'GET', path + '?limit=10');
    expect(first.body.attempts.map((r) => r.attempt)).toEqual([
      1,
      ...Array.from({ length: 9 }, (_, j) => j + 12),
    ]);
    expect(first.body.nextAttemptsCursor).toEqual(expect.any(String));
    // Нова спроба після першої сторінки не зсуває сторінки, зафіксовані курсором.
    await addAttempts(31, 31);
    const tail = await call<Page>(
      a,
      'GET',
      path + '?limit=10&cursor=' + first.body.nextAttemptsCursor,
    );
    expect(tail.body.attempts.map((r) => r.attempt)).toEqual(
      Array.from({ length: 10 }, (_, j) => j + 21),
    );
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
    expect(legacy.body.attempts.map((r) => r.attempt)).toEqual([
      1,
      ...Array.from({ length: 19 }, (_, j) => j + 13),
    ]);
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
