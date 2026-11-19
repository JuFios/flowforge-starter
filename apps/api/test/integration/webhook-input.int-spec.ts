import { signedHeaders } from '../helpers/webhook';
import { DataSource } from 'typeorm';
import { Execution } from '../../src/entities';
import { RunningApp, startApp } from '../helpers/app';
import {
  createTenant,
  createWorkflow,
  openTestDataSource,
  truncateAll,
} from '../helpers/db';

/**
 * Неавтентифікований webhook-запит отримує 401 незалежно від вмісту тіла: пояснення щодо формату
 * входу — лише тому, хто довів, що знає секрет.
 */
describe('webhook input is validated only after the signature', () => {
  let ds: DataSource;
  let running: RunningApp;
  let workflowId: string;
  let secret: string;

  beforeAll(async () => {
    ds = await openTestDataSource();
    running = await startApp();
  });

  beforeEach(async () => {
    await truncateAll(ds);
    const { tenant } = await createTenant(ds);
    secret = tenant.webhookSecret;
    workflowId = (await createWorkflow(ds, tenant.id)).id;
  });

  afterAll(async () => {
    await running.close();
    await ds.destroy();
  });

  const sign = (body: unknown) =>
    signedHeaders(workflowId, secret, JSON.stringify(body));
  const deliver = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${running.baseUrl}/hooks/${workflowId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  it('authenticates the bytes sent by the client, including whitespace', async () => {
    const body = '{ "order" : 42 }';
    const res = await fetch(`${running.baseUrl}/hooks/${workflowId}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...signedHeaders(workflowId, secret, body),
      },
      body,
    });
    expect(res.status).toBe(202);
  });

  it('enqueues one execution and one job after a sender repeats a delivery', async () => {
    const body = { order: 42 };
    const signature = sign(body);
    expect((await deliver(body, signature)).status).toBe(202);
    expect((await deliver(body, signature)).status).toBe(202);
    const counts: unknown = await ds.query(
      'SELECT (SELECT count(*)::int FROM executions) AS executions, (SELECT count(*)::int FROM jobs) AS jobs',
    );
    expect(counts).toEqual([{ executions: 1, jobs: 1 }]);
  });

  it('rolls back the receipt, execution and job together and accepts the retry', async () => {
    const body = { recovery: true },
      headers = sign(body);
    await ds.query(
      'ALTER TABLE webhook_deliveries ADD CONSTRAINT test_receipt_failure CHECK (false) NOT VALID',
    );
    try {
      expect((await deliver(body, headers)).status).toBe(500);
      const counts: unknown = await ds.query(
        'SELECT (SELECT count(*)::int FROM executions) e,(SELECT count(*)::int FROM jobs) j,(SELECT count(*)::int FROM webhook_deliveries) d',
      );
      expect(counts).toEqual([{ e: 0, j: 0, d: 0 }]);
    } finally {
      await ds.query(
        'ALTER TABLE webhook_deliveries DROP CONSTRAINT test_receipt_failure',
      );
    }
    const first = await deliver(body, headers),
      replay = await deliver(body, headers);
    expect(first.status).toBe(202);
    expect(await replay.json()).toEqual(await first.json());
  });

  it('accepts empty signed bytes but rejects a signed JSON null', async () => {
    for (const [body, expected] of [
      ['', 202],
      ['null', 400],
    ] as const) {
      const response = await fetch(running.baseUrl + '/hooks/' + workflowId, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...signedHeaders(workflowId, secret, body),
        },
        body,
      });
      expect(response.status).toBe(expected);
    }
    expect(await ds.getRepository(Execution).count()).toBe(1);
  });
  const invalidInputs: Array<[string, unknown]> = [
    ['an array', [1, 2]],
    ['an object above 64 KiB', { data: 'x'.repeat(64 * 1024) }],
  ];

  it.each(invalidInputs)(
    'answers an unsigned delivery of %s with 401 and no details',
    async (_name, body) => {
      const res = await deliver(body);
      expect(res.status).toBe(401);
      expect(await res.text()).not.toMatch(/JSON|байт|об'єкт/);
    },
  );

  it.each(invalidInputs)(
    'answers a wrongly signed delivery of %s with 401',
    async (_name, body) => {
      const res = await deliver(body, {
        ...sign(body),
        'x-signature': 'v1=' + 'f'.repeat(64),
      });
      expect(res.status).toBe(401);
    },
  );

  it.each(invalidInputs)(
    'answers a correctly signed delivery of %s with 400',
    async (_name, body) => {
      const res = await deliver(body, sign(body));
      expect(res.status).toBe(400);
      expect(await ds.getRepository(Execution).count()).toBe(0);
    },
  );

  it('accepts a correctly signed valid delivery', async () => {
    const body = { order: 42 };
    const res = await deliver(body, sign(body));
    expect(res.status).toBe(202);
    const { executionId } = (await res.json()) as { executionId: string };
    expect(
      await ds.getRepository(Execution).findOneByOrFail({ id: executionId }),
    ).toMatchObject({ input: body, trigger: 'webhook' });
  });
});
