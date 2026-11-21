import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { hashApiKey } from '../../src/auth/api-key.guard';
import { testDatabaseUrl } from '../helpers/test-env';
import { DataSource } from 'typeorm';
import { migrate } from '../../src/database/migrate';
import { ExecutionsService } from '../../src/executions/executions.service';
import { Execution, Job } from '../../src/entities';
import { RunningApp, startApp } from '../helpers/app';
import {
  createTenant,
  createWorkflow,
  openTestDataSource,
  truncateAll,
} from '../helpers/db';
import { startWorker, waitFor } from '../helpers/queue';
import { signedHeaders } from '../helpers/webhook';

describe('webhook upgrade, concurrent acceptance and revocation', () => {
  let db: DataSource;
  const services: RunningApp[] = [];
  beforeAll(async () => {
    db = await openTestDataSource();
  });
  afterEach(async () => {
    while (services.length) await services.pop()!.close();
    await migrate(db);
  });
  afterAll(async () => {
    await db.destroy();
  });

  it('rechecks the verified key after a concurrent revocation and isolates key management', async () => {
    await truncateAll(db);
    const owner = await createTenant(db, 'owner'),
      other = await createTenant(db, 'other');
    const wf = await createWorkflow(db, owner.tenant.id);
    const a = await startApp(),
      b = await startApp();
    services.push(a, b);
    const manage = (key: string, method: string, suffix = '') =>
      fetch(b.baseUrl + '/tenants/me/webhook-secrets' + suffix, {
        method,
        headers: { 'x-api-key': key },
      });
    expect((await manage('', 'POST')).status).toBe(401);
    const original = (await (await manage(owner.apiKey, 'GET')).json()) as {
      id: string;
    }[];
    expect(await (await manage(other.apiKey, 'GET')).json()).not.toEqual(
      original,
    );
    expect(
      (await manage(other.apiKey, 'DELETE', '/' + original[0].id)).status,
    ).toBe(204);
    expect(await (await manage(owner.apiKey, 'GET')).json()).toEqual(original);
    expect((await manage(owner.apiKey, 'POST')).status).toBe(201);
    const service = a.app.get(ExecutionsService),
      enqueue = service.enqueueWebhook.bind(service);
    let reached!: () => void, release!: () => void;
    const verified = new Promise<void>((r) => {
        reached = r;
      }),
      proceed = new Promise<void>((r) => {
        release = r;
      });
    const spy = jest
      .spyOn(service, 'enqueueWebhook')
      .mockImplementationOnce(async (...args) => {
        reached();
        await proceed;
        return enqueue(...args);
      });
    const request = fetch(a.baseUrl + '/hooks/' + wf.id, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...signedHeaders(wf.id, owner.tenant.webhookSecret, '{}'),
      },
      body: '{}',
    });
    try {
      await Promise.race([
        verified,
        request.then(() => {
          throw new Error('delivery ended before reaching enqueue');
        }),
      ]);
      expect(
        (await manage(owner.apiKey, 'DELETE', '/' + original[0].id)).status,
      ).toBe(204);
    } finally {
      release();
      spy.mockRestore();
    }
    expect((await request).status).toBe(401);
    expect(await db.getRepository(Job).count()).toBe(0);
    expect(await db.getRepository(Execution).count()).toBe(0);
  });

  it('keeps one receipt, execution and initial job across two APIs and rotates a migrated tenant without downtime', async () => {
    await truncateAll(db);
    // До міграції WebhookDeliveries (і всіх новіших): схема попередньої версії.
    for (;;) {
      const [last]: Array<{ name: string }> = await db.query(
        'SELECT name FROM migrations ORDER BY id DESC LIMIT 1',
      );
      await db.undoLastMigration({ transaction: 'each' });
      if (last.name.startsWith('WebhookDeliveries')) break;
    }
    const apiKey = randomUUID();
    const [tenant]: Array<{ id: string; webhookSecret: string }> =
      await db.query(
        'INSERT INTO tenants(name,"apiKeyHash","webhookSecret") VALUES ($1,$2,$3) RETURNING id,"webhookSecret"',
        ['legacy', hashApiKey(apiKey), randomUUID()],
      );
    // Рядки старої схеми — прямим SQL: сутності описують уже найновішу схему.
    const [workflow]: Array<{ id: string }> = await db.query(
      `INSERT INTO workflows ("tenantId", name, steps)
       VALUES ($1, 'wf', '[{"id":"say","type":"log","message":"hello {{ input.name }}"}]')
       RETURNING id`,
      [tenant.id],
    );
    const [version]: Array<{ id: string }> = await db.query(
      `INSERT INTO workflow_versions ("workflowId", "tenantId", version, steps)
       SELECT id, "tenantId", version, steps FROM workflows WHERE id = $1 RETURNING id`,
      [workflow.id],
    );
    const [old]: Array<{ id: string }> = await db.query(
      `INSERT INTO executions ("tenantId", "workflowId", "workflowVersionId", input)
       VALUES ($1, $2, $3, '{"name":"before update"}') RETURNING id`,
      [tenant.id, workflow.id, version.id],
    );
    await db.query(
      'INSERT INTO jobs ("tenantId", "executionId") VALUES ($1, $2)',
      [tenant.id, old.id],
    );
    const report = await promisify(execFile)(
      process.execPath,
      [resolve(__dirname, '../../dist/database/webhook-preflight.js')],
      { env: { MIGRATION_DATABASE_URL: testDatabaseUrl() } },
    );
    expect(report.stdout).toContain('"review":0');
    await migrate(db);
    const a = await startApp(undefined, { captureLogs: true });
    services.push(a);
    const b = await startApp(undefined, { captureLogs: true });
    services.push(b);
    const keys = (s: RunningApp, method: string, suffix = '') =>
      fetch(s.baseUrl + '/tenants/me/webhook-secrets' + suffix, {
        method,
        headers: { 'x-api-key': apiKey },
      });
    const send = (
      s: RunningApp,
      id: string,
      secret: string,
      body = '{ "name": "Ada" }',
    ) =>
      fetch(s.baseUrl + '/hooks/' + workflow.id, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...signedHeaders(workflow.id, secret, body, id),
        },
        body,
      });
    for (const [i, s] of [a, b].entries())
      expect((await send(s, 'warm-' + i, tenant.webhookSecret)).status).toBe(
        202,
      );
    const original = (await (await keys(a, 'GET')).json()) as { id: string }[];
    const rotations = await Promise.all([keys(a, 'POST'), keys(b, 'POST')]);
    expect(rotations.map((r) => r.status).sort()).toEqual([201, 409]);
    const response = rotations.find((r) => r.status === 201)!;
    expect(response.headers.get('cache-control')).toBe('no-store');
    const fresh = (await response.json()) as { id: string; secret: string };
    const blocker = db.createQueryRunner();
    await blocker.connect();
    await blocker.startTransaction();
    const pending: Promise<Response>[] = [];
    try {
      await blocker.query(
        'SELECT 1 FROM tenant_usage WHERE "tenantId"=$1 FOR UPDATE',
        [tenant.id],
      );
      pending.push(
        send(a, 'order-42', tenant.webhookSecret),
        send(b, 'order-42', fresh.secret),
      );
      await waitFor(
        'both enqueue transactions waiting for the usage row',
        async () => {
          const [row]: { n: number }[] = await db.query(
            "SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND query LIKE '%FROM lock_tenant_usage()%' AND cardinality(pg_blocking_pids(pid))>0",
          );
          return row.n === 2;
        },
      );
    } finally {
      await blocker.rollbackTransaction();
      await blocker.release();
    }
    const replies = await Promise.all(pending);
    expect(replies.map((r) => r.status)).toEqual([202, 202]);
    const results = await Promise.all(
      replies.map((r) => r.json() as Promise<{ executionId: string }>),
    );
    expect(results[0]).toEqual(results[1]);
    const tx =
      'SELECT "executionId" FROM webhook_deliveries WHERE "tenantId"=$1 AND "workflowId"=$2 AND "deliveryId"=$3';
    const plan: unknown = await db.query('EXPLAIN (FORMAT JSON) ' + tx, [
      tenant.id,
      workflow.id,
      'order-42',
    ]);
    expect(JSON.stringify(plan)).toContain('webhook_deliveries_pkey');
    const initial = await db
      .getRepository(Job)
      .countBy({ executionId: results[0].executionId });
    expect(initial).toBe(1);
    const counts = () =>
      db.query(
        'SELECT (SELECT count(*)::int FROM webhook_deliveries) AS receipts,(SELECT count(*)::int FROM executions) AS executions,(SELECT count(*)::int FROM jobs) AS jobs',
      );
    expect(await counts()).toEqual([{ receipts: 3, executions: 4, jobs: 4 }]);
    expect((await send(a, 'order-42', fresh.secret, '{}')).status).toBe(409);
    const worker = await startWorker();
    services.push(worker);
    await waitFor(
      'worker completed the signed delivery',
      async () =>
        (
          await db
            .getRepository(Execution)
            .findOneByOrFail({ id: results[0].executionId })
        ).status === 'succeeded',
    );
    await waitFor(
      'the execution queued before the upgrade',
      async () =>
        (await db.getRepository(Execution).findOneByOrFail({ id: old.id }))
          .status === 'succeeded',
    );
    expect((await keys(b, 'DELETE', '/' + original[0].id)).status).toBe(204);
    for (const [i, s] of [a, b].entries())
      expect((await send(s, 'revoked-' + i, tenant.webhookSecret)).status).toBe(
        401,
      );
    expect(await counts()).toEqual([{ receipts: 3, executions: 4, jobs: 4 }]);
    expect((await send(b, 'new', fresh.secret)).status).toBe(202);
    expect((await keys(a, 'DELETE', '/' + fresh.id)).status).toBe(409);
    const diagnostic = JSON.stringify([
      a.logs,
      b.logs,
      await (await keys(b, 'GET')).json(),
    ]);
    expect(diagnostic).not.toContain(fresh.secret);
    expect(diagnostic).not.toContain(tenant.webhookSecret);
  });
});
