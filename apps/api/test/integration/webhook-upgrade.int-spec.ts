import { DataSource } from 'typeorm';
import { migrate } from '../../src/database/migrate';
import { Execution } from '../../src/entities';
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

  it('keeps one receipt, execution and initial job across two APIs and rotates a migrated tenant without downtime', async () => {
    await truncateAll(db);
    await db.undoLastMigration({ transaction: 'each' });
    const { tenant, apiKey } = await createTenant(db);
    const workflow = await createWorkflow(db, tenant.id);
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
    const counts = () =>
      db.query(
        'SELECT (SELECT count(*)::int FROM webhook_deliveries) AS receipts,(SELECT count(*)::int FROM executions) AS executions,(SELECT count(*)::int FROM jobs) AS jobs',
      ) as Promise<unknown>;
    expect(await counts()).toEqual([{ receipts: 3, executions: 3, jobs: 3 }]);
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
    expect((await keys(b, 'DELETE', '/' + original[0].id)).status).toBe(204);
    for (const [i, s] of [a, b].entries())
      expect((await send(s, 'revoked-' + i, tenant.webhookSecret)).status).toBe(
        401,
      );
    expect(await counts()).toEqual([{ receipts: 3, executions: 3, jobs: 3 }]);
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
