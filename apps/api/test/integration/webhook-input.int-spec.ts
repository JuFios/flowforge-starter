import { createHmac } from 'node:crypto';
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

  /** Підпис у форматі, який зараз перевіряє контролер (HMAC серіалізованого тіла). */
  const sign = (body: unknown) =>
    createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');

  const deliver = (body: unknown, signature?: string) =>
    fetch(`${running.baseUrl}/hooks/${workflowId}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(signature !== undefined && { 'x-signature': signature }),
      },
      body: JSON.stringify(body),
    });

  it('authenticates the bytes sent by the client, including whitespace', async () => {
    const body = '{ "order" : 42 }';
    const res = await fetch(`${running.baseUrl}/hooks/${workflowId}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signature': createHmac('sha256', secret).update(body).digest('hex'),
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
      const res = await deliver(body, 'f'.repeat(64));
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
