import { DataSource } from 'typeorm';
import { WorkerModule } from '../../src/app.module';
import { OutboxMetrics } from '../../src/outbox/outbox.metrics';
import { OutboxSender } from '../../src/outbox/outbox-sender.service';
import { SchedulerService } from '../../src/scheduler/scheduler.service';
import { RunningApp, startApp } from '../helpers/app';
import {
  createExecution,
  createTenant,
  createWorkflow,
  openTestDataSource,
  truncateAll,
} from '../helpers/db';
import {
  configureNotifications,
  verifyNotification,
} from '../helpers/notifications';
import { Receiver, sleep, waitFor } from '../helpers/queue';

interface EventRow {
  id: string;
  status: string;
  attempts: number;
  payload: string;
  correlationId: string | null;
  lastError: string | null;
}

/**
 * Доставка сповіщень (ТЗ 3.3.9): «щонайменше один раз» з тим самим ID і тими самими байтами,
 * fencing-токен проти запізнілого результату, політика вихідного HTTP на фактичному шляху.
 */
describe('notification delivery', () => {
  let ds: DataSource;
  let api: RunningApp;
  let workers: RunningApp[] = [];
  const receiver = new Receiver();
  let tenantId: string;
  let apiKey: string;
  let secret: string;

  /** Воркер без циклів: тест сам викликає спроби (`deliverNext`). */
  async function sender(): Promise<OutboxSender> {
    const worker = await startApp(WorkerModule);
    workers.push(worker);
    return worker.app.get(OutboxSender);
  }

  /** Виконання тенанта, що перейшло в кінцевий стан (тригер пише подію). */
  async function complete(
    status: 'succeeded' | 'failed' = 'succeeded',
    correlationId = 'req-delivery-1',
  ): Promise<EventRow> {
    const wf = await createWorkflow(ds, tenantId);
    const execution = await createExecution(ds, wf, { correlationId });
    await ds.query(
      `UPDATE executions SET status = $2, "finishedAt" = now(), error = $3 WHERE id = $1`,
      [execution.id, status, status === 'failed' ? 'boom' : null],
    );
    const [event]: EventRow[] = await ds.query(
      'SELECT * FROM outbox_events WHERE "executionId" = $1',
      [execution.id],
    );
    return event;
  }

  async function event(id: string): Promise<EventRow> {
    const rows: EventRow[] = await ds.query(
      'SELECT * FROM outbox_events WHERE id = $1',
      [id],
    );
    return rows[0];
  }

  async function outcome(name: string, app: RunningApp): Promise<number> {
    const { values } = await app.app.get(OutboxMetrics).attempts.get();
    return values.find((v) => v.labels.outcome === name)?.value ?? 0;
  }

  beforeAll(async () => {
    ds = await openTestDataSource();
    await receiver.start();
    api = await startApp();
    api.app.get(SchedulerService).onApplicationShutdown();
  });
  beforeEach(async () => {
    await truncateAll(ds);
    receiver.requests.length = 0;
    receiver.respond = (_req, res) => {
      res.writeHead(204);
      res.end();
    };
    const created = await createTenant(ds);
    tenantId = created.tenant.id;
    apiKey = created.apiKey;
    ({ secret } = await configureNotifications(
      api,
      apiKey,
      receiver.url('/hooks/flowforge'),
    ));
  });
  afterEach(async () => {
    for (const w of workers) await w.close();
    workers = [];
    await ds.query('DROP TRIGGER IF EXISTS test_outbox_hook ON outbox_events');
    await ds.query('DROP FUNCTION IF EXISTS test_outbox_hook()');
    await ds.query('DROP SEQUENCE IF EXISTS test_outbox_hook');
  });
  afterAll(async () => {
    await api.close();
    await receiver.stop();
    await truncateAll(ds);
    await ds.destroy();
  });

  it('keeps a cancelled event fenced when the old receiver responds after a new PUT', async () => {
    const old = await complete();
    const worker = await sender();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    receiver.respond = async (_req, res) => {
      await pending;
      res.writeHead(503).end();
    };
    const delivery = worker.deliverNext();
    try {
      await waitFor('old HTTP request', () => receiver.requests.length === 1);
      const res = await fetch(`${api.baseUrl}/tenants/me/notifications`, {
        method: 'DELETE',
        headers: { 'x-api-key': apiKey },
      });
      expect(res.status).toBe(204);
      await configureNotifications(api, apiKey, receiver.url('/new'));
    } finally {
      release();
      await delivery;
    }
    expect((await event(old.id)).status).toBe('cancelled');
    expect(await worker.deliverNext()).toBe(false);
  });

  it('reclaims a failed delivery at backoff before the previous lease expires', async () => {
    const e = await complete();
    const first = await sender(),
      second = await sender();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    receiver.respond = async (_req, res) => {
      await waiting;
      res.writeHead(503, { 'Retry-After': '1' }).end();
    };
    const delivery = first.deliverNext();
    let oldLease: Date;
    try {
      await waitFor('first HTTP attempt', () => receiver.requests.length === 1);
      expect(await second.deliverNext()).toBe(false);
      const [row] = await ds.query<Array<{ lease: Date; due: Date }>>(
        'SELECT "leaseUntil" AS lease, "dueAt" AS due FROM outbox_events JOIN notification_settings USING ("tenantId") WHERE id=$1',
        [e.id],
      );
      expect(row.due).toEqual(row.lease);
      oldLease = row.lease;
    } finally {
      release();
      await delivery;
    }
    expect(await second.deliverNext()).toBe(false);
    await waitFor(
      'database backoff deadline',
      async () =>
        (
          await ds.query<Array<{ ready: boolean }>>(
            'SELECT clock_timestamp() >= "nextAttemptAt" AS ready FROM outbox_events WHERE id=$1',
            [e.id],
          )
        )[0].ready,
    );
    receiver.respond = (_req, res) => {
      res.writeHead(204).end();
    };
    expect(await second.deliverNext()).toBe(true);
    expect(
      (
        await ds.query<Array<{ before: boolean }>>(
          'SELECT clock_timestamp() < $1::timestamptz AS before',
          [oldLease],
        )
      )[0].before,
    ).toBe(true);
    expect((await event(e.id)).status).toBe('delivered');
  });

  it('delivers the stored bytes once, signed, with the event id and the correlation id', async () => {
    const e = await complete();
    expect(e.status).toBe('pending');
    const s = await sender();
    expect(await s.deliverNext()).toBe(true);
    const [req] = receiver.hits('/hooks/flowforge');
    expect(req.method).toBe('POST');
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.headers['x-flowforge-event-id']).toBe(e.id);
    expect(req.headers['x-flowforge-attempt']).toBe('1');
    expect(req.headers['x-request-id']).toBe('req-delivery-1');
    // Точні збережені байти — без повторної серіалізації.
    expect(req.raw.equals(Buffer.from(e.payload, 'utf8'))).toBe(true);
    expect(verifyNotification(req.headers, req.raw, secret)).toBe(true);
    expect(verifyNotification(req.headers, req.raw, 'x'.repeat(64))).toBe(
      false,
    );
    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      specVersion: 1,
      id: e.id,
      type: 'execution.succeeded',
      tenantId,
      correlationId: 'req-delivery-1',
      data: { sequence: 1, status: 'succeeded', error: null },
    });
    expect((await event(e.id)).status).toBe('delivered');
    expect(await s.deliverNext()).toBe(false);
    expect(receiver.requests).toHaveLength(1);
    const attempts: unknown[] = await ds.query(
      'SELECT attempt, outcome, "httpStatus", revision, "keyIds" FROM outbox_attempts WHERE "eventId" = $1',
      [e.id],
    );
    expect(attempts).toEqual([
      {
        attempt: 1,
        outcome: 'delivered',
        httpStatus: 204,
        revision: 1,
        keyIds: [expect.any(String)],
      },
    ]);
  });

  it('delivers again with the same id and bytes when the acknowledgement is lost', async () => {
    const e = await complete();
    let calls = 0;
    // Перший запит прийнято, але відповідь не дійшла: з'єднання обірвано до статусу.
    receiver.respond = (_req, res) => {
      if (++calls === 1) res.socket?.destroy();
      else {
        res.writeHead(200);
        res.end();
      }
    };
    const s = await sender();
    await s.deliverNext();
    expect((await event(e.id)).status).toBe('pending');
    expect((await event(e.id)).lastError).toBe('network');
    await waitFor('the retry to become due', async () => s.deliverNext());
    const hits = receiver.hits('/hooks/flowforge');
    // Два HTTP-запити — це і є «щонайменше один раз»: отримувач дедуплікує за ID.
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.headers['x-flowforge-event-id'])).toEqual([
      e.id,
      e.id,
    ]);
    expect(hits.map((h) => h.headers['x-flowforge-attempt'])).toEqual([
      '1',
      '2',
    ]);
    expect(hits[1].raw.equals(hits[0].raw)).toBe(true);
    for (const h of hits)
      expect(verifyNotification(h.headers, h.raw, secret)).toBe(true);
    expect((await event(e.id)).status).toBe('delivered');
  });

  it('redelivers after a sender crashed between the 2xx and recording it', async () => {
    const e = await complete();
    // Збій запису результату після 2xx (як падіння процесу): спроба лишається `sending`.
    await ds.query(`
      CREATE FUNCTION test_outbox_hook() RETURNS trigger AS $$
      BEGIN
        IF NEW.status = 'delivered' AND nextval('public.test_outbox_hook') = 1 THEN
          RAISE EXCEPTION 'simulated crash before the delivery was recorded';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public`);
    await ds.query('CREATE SEQUENCE test_outbox_hook');
    await ds.query('REVOKE ALL ON FUNCTION test_outbox_hook() FROM PUBLIC');
    await ds.query(`CREATE TRIGGER test_outbox_hook BEFORE UPDATE ON outbox_events
      FOR EACH ROW EXECUTE FUNCTION test_outbox_hook()`);
    const first = await sender();
    await first.deliverNext();
    expect((await event(e.id)).status).toBe('sending');
    // Інший відправник не бере спробу, поки lease чинний…
    const second = await sender();
    expect(await second.deliverNext()).toBe(false);
    // …а після спливання lease доставляє ту саму подію (час «минає»: lease і підказка тенанта,
    // яку попереднє захоплення перерахувало на момент спливання lease).
    await ds.query(
      `UPDATE outbox_events SET "leaseUntil" = now() - interval '1 second' WHERE id = $1`,
      [e.id],
    );
    await ds.query(
      `UPDATE notification_settings SET "dueAt" = now() - interval '1 second' WHERE "tenantId" = $1`,
      [tenantId],
    );
    expect(await second.deliverNext()).toBe(true);
    const hits = receiver.hits('/hooks/flowforge');
    expect(hits).toHaveLength(2);
    expect(hits[1].headers['x-flowforge-event-id']).toBe(e.id);
    expect(hits[1].raw.equals(hits[0].raw)).toBe(true);
    expect((await event(e.id)).status).toBe('delivered');
    const attempts: Array<{ attempt: number; outcome: string }> =
      await ds.query(
        'SELECT attempt, outcome FROM outbox_attempts WHERE "eventId" = $1 ORDER BY attempt',
        [e.id],
      );
    expect(attempts).toEqual([
      { attempt: 1, outcome: 'lease_expired' },
      { attempt: 2, outcome: 'delivered' },
    ]);
  });

  it('ignores the late result of an attempt whose lease another sender took over', async () => {
    const e = await complete();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let calls = 0;
    receiver.respond = async (_req, res) => {
      if (++calls === 1) {
        // Старий відправник завис: його відповідь прийде пізніше за чужу доставку.
        await held;
        res.writeHead(500);
        res.end();
        return;
      }
      res.writeHead(200);
      res.end();
    };
    const old = await sender();
    const slow = old.deliverNext();
    await waitFor('the first attempt to reach the receiver', () => calls === 1);
    await ds.query(
      `UPDATE outbox_events SET "leaseUntil" = now() - interval '1 second' WHERE id = $1`,
      [e.id],
    );
    const fresh = await sender();
    expect(await fresh.deliverNext()).toBe(true);
    expect((await event(e.id)).status).toBe('delivered');
    const staleBefore = await outcome('stale', workers[0]);
    release();
    await slow;
    // Запізнілий 500 не повернув доставлену подію в чергу й не переписав журнал новішої спроби.
    expect((await event(e.id)).status).toBe('delivered');
    expect(await outcome('stale', workers[0])).toBe(staleBefore + 1);
    const attempts: Array<{ attempt: number; outcome: string }> =
      await ds.query(
        'SELECT attempt, outcome FROM outbox_attempts WHERE "eventId" = $1 ORDER BY attempt',
        [e.id],
      );
    expect(attempts).toEqual([
      { attempt: 1, outcome: 'lease_expired' },
      { attempt: 2, outcome: 'delivered' },
    ]);
  });

  it('does not follow a redirect and counts it as a failed attempt', async () => {
    const e = await complete();
    receiver.respond = (req, res) => {
      if (req.path === '/hooks/flowforge') {
        res.writeHead(302, { location: receiver.url('/elsewhere') });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end();
    };
    const s = await sender();
    await s.deliverNext();
    expect(receiver.hits('/elsewhere')).toEqual([]);
    expect(await event(e.id)).toMatchObject({
      status: 'pending',
      lastError: 'redirect',
    });
  });

  it('refuses an address the policy forbids at connection time and keeps the event', async () => {
    const e = await complete();
    // Збережений URL тепер вказує на ім'я з внутрішньою адресою (як після зміни DNS).
    const { port } = new URL(receiver.url('/'));
    await ds.query(
      `UPDATE notification_settings SET url = $2 WHERE "tenantId" = $1`,
      [tenantId, `http://localhost:${port}/hooks/flowforge`],
    );
    const s = await sender();
    await s.deliverNext();
    expect(receiver.requests).toEqual([]);
    expect(await event(e.id)).toMatchObject({
      status: 'pending',
      lastError: 'denied',
    });
  });

  it('keeps retrying with growing backoff and no attempt limit until the receiver answers 2xx', async () => {
    const e = await complete();
    let calls = 0;
    receiver.respond = (_req, res) => {
      res.writeHead(++calls <= 6 ? 503 : 200);
      res.end();
    };
    const s = await sender();
    await waitFor(
      'the event to be delivered',
      async () => {
        await s.deliverNext();
        return (await event(e.id)).status === 'delivered';
      },
      { timeoutMs: 20_000, intervalMs: 20 },
    );
    // Більше за JOB_MAX_ATTEMPTS (3): ліміту спроб доставки немає.
    expect((await event(e.id)).attempts).toBe(7);
    const times: Array<{ at: Date }> = await ds.query(
      'SELECT "startedAt" AS at FROM outbox_attempts WHERE "eventId" = $1 ORDER BY attempt',
      [e.id],
    );
    for (let i = 1; i < times.length; i++)
      expect(
        times[i].at.getTime() - times[i - 1].at.getTime(),
      ).toBeGreaterThanOrEqual(90); // OUTBOX_BACKOFF_BASE_MS = 100 у тестах
  });

  it('waits at least as long as Retry-After asks, within the backoff ceiling', async () => {
    const e = await complete();
    receiver.respond = (_req, res) => {
      res.writeHead(429, { 'retry-after': '1' });
      res.end();
    };
    const s = await sender();
    await s.deliverNext();
    const [{ wait }]: Array<{ wait: number }> = await ds.query(
      `SELECT extract(epoch FROM "nextAttemptAt" - now()) AS wait FROM outbox_events WHERE id = $1`,
      [e.id],
    );
    // OUTBOX_BACKOFF_MAX_MS у тестах — 1 с: побажання отримувача не продовжує паузу понад стелю.
    expect(Number(wait)).toBeGreaterThan(0.8);
    expect(Number(wait)).toBeLessThanOrEqual(1.05);
  });

  it('reaches a tenant behind more than a claim window of tenants at their in-flight limit', async () => {
    const e = await complete();
    await ds.query(
      `UPDATE notification_settings SET "lastClaimedAt" = now() WHERE "tenantId" = $1`,
      [tenantId],
    );
    // 20 тенантів, давніше обслужених, із двома спробами в роботі кожен (ліміт 2) і подією, що чекає.
    for (let i = 0; i < 20; i++) {
      const busy = await createTenant(ds, `busy-${i}`);
      await ds.query(
        `INSERT INTO notification_settings ("tenantId", url, secret, "dueAt", "lastClaimedAt")
         VALUES ($1, $2, $3, now() - interval '1 minute', now() - interval '1 hour')`,
        [busy.tenant.id, receiver.url('/busy'), 'b'.repeat(64)],
      );
      await ds.query(
        `INSERT INTO outbox_events ("tenantId", "executionId", sequence, type, payload, status,
                                    "leaseToken", "leaseUntil")
         SELECT $1, gen_random_uuid(), 1, 'execution.succeeded', '{}',
                CASE WHEN g <= 2 THEN 'sending' ELSE 'pending' END,
                CASE WHEN g <= 2 THEN gen_random_uuid() END,
                CASE WHEN g <= 2 THEN now() + interval '1 minute' END
           FROM generate_series(1, 3) g`,
        [busy.tenant.id],
      );
    }
    const s = await sender();
    expect(await s.deliverNext()).toBe(true);
    expect((await event(e.id)).status).toBe('delivered');
    expect(receiver.hits('/busy')).toEqual([]);
  });

  it('keeps delivering to other tenants while one endpoint hangs', async () => {
    // Тенант A: endpoint не відповідає до таймауту; тенант B — відповідає одразу.
    receiver.respond = async (req, res) => {
      if (req.path === '/slow') await sleep(3_000);
      res.writeHead(200);
      res.end();
    };
    await api.app.get(SchedulerService).beforeApplicationShutdown();
    const slowTenant = tenantId;
    await ds.query(
      `UPDATE notification_settings SET url = $2 WHERE "tenantId" = $1`,
      [slowTenant, receiver.url('/slow')],
    );
    for (let i = 0; i < 10; i++) await complete();
    const other = await createTenant(ds, 'other');
    tenantId = other.tenant.id;
    await configureNotifications(api, other.apiKey, receiver.url('/fast'));
    const fastEvents: string[] = [];
    for (let i = 0; i < 5; i++) fastEvents.push((await complete()).id);
    const worker = await startApp(WorkerModule);
    workers.push(worker);
    worker.app.get(OutboxSender).start(4);
    const started = Date.now();
    await waitFor(
      'every event of the other tenant to be delivered',
      async () => {
        const rows: unknown[] = await ds.query(
          `SELECT 1 FROM outbox_events WHERE id = ANY($1) AND status = 'delivered'`,
          [fastEvents],
        );
        return rows.length === fastEvents.length;
      },
      { timeoutMs: 10_000 },
    );
    // Повільний тенант займає не більше OUTBOX_TENANT_IN_FLIGHT (2) спроб, решта циклів вільні.
    expect(Date.now() - started).toBeLessThan(2_500);
    const [{ busy }]: Array<{ busy: number }> = await ds.query(
      `SELECT count(*)::int AS busy FROM outbox_events WHERE "tenantId" = $1 AND status = 'sending'`,
      [slowTenant],
    );
    expect(busy).toBeLessThanOrEqual(2);
  });
});
