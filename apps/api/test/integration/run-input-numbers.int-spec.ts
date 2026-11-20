import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { Execution, Job, Tenant, Workflow } from '../../src/entities';
import { RunningApp, startApp } from '../helpers/app';
import {
  createTenant,
  createWorkflow,
  openTestDataSource,
  truncateAll,
} from '../helpers/db';
import { TEST_ADMIN_TOKEN } from '../helpers/test-env';
import { signedHeaders } from '../helpers/webhook';

/**
 * Число JSON, яке змінилося б після розбору (`1e400` → `Infinity` → `null`, ціле поза точністю
 * double), відхиляється на межі API з 400 — і для ручного запуску, і для підписаного webhook,
 * і для будь-якого іншого JSON-маршруту. Точні числа зберігаються такими, як надіслані.
 */
describe('JSON numbers that would change before storage', () => {
  let ds: DataSource;
  let apiApp: RunningApp;
  let apiKey: string;
  let tenantId: string;

  beforeAll(async () => {
    ds = await openTestDataSource();
    apiApp = await startApp(AppModule);
  });

  beforeEach(async () => {
    await truncateAll(ds);
    ({
      apiKey,
      tenant: { id: tenantId },
    } = await createTenant(ds));
  });

  afterAll(async () => {
    await apiApp.close();
    await ds.destroy();
  });

  /** Сирий текст тіла: JSON.stringify не може записати 1e400 чи 20 значущих цифр. */
  const send = (
    method: string,
    path: string,
    text: string,
    headers: Record<string, string> = { 'x-api-key': apiKey },
  ) =>
    fetch(`${apiApp.baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: text,
    });

  const inexact = [
    '{"amount":1e400}',
    '{"amount":-1e400}',
    '{"amount":1e-400}',
    '{"order":{"id":12345678901234567890}}',
    '{"items":[1,2,9007199254740993]}',
  ];

  it.each(inexact)(
    'rejects a manual run with %s (400) and creates nothing',
    async (text) => {
      const wf = await createWorkflow(ds, tenantId);
      const res = await send('POST', `/workflows/${wf.id}/run`, text);
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toContain('$.');
      expect(await ds.getRepository(Execution).count()).toBe(0);
      expect(await ds.getRepository(Job).count()).toBe(0);
    },
  );

  it('authenticates before explaining the body: no key gives 401', async () => {
    const wf = await createWorkflow(ds, tenantId);
    const res = await send('POST', `/workflows/${wf.id}/run`, inexact[0], {});
    expect(res.status).toBe(401);
  });

  it('stores exact numbers exactly as sent', async () => {
    const wf = await createWorkflow(ds, tenantId);
    const text =
      '{"price":0.1,"qty":3,"max":9007199254740991,"tiny":5e-324,"neg":-12.5,"zero":-0}';
    const res = await send('POST', `/workflows/${wf.id}/run`, text);
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const execution = await ds.getRepository(Execution).findOneByOrFail({ id });
    expect(execution.input).toEqual({
      price: 0.1,
      qty: 3,
      max: 9007199254740991,
      tiny: 5e-324,
      neg: -12.5,
      zero: 0,
    });
  });

  it.each(inexact)(
    'rejects a signed webhook with %s (400) without using up the delivery',
    async (text) => {
      const wf = await createWorkflow(ds, tenantId);
      const { webhookSecret } = await ds
        .getRepository(Tenant)
        .findOneByOrFail({ id: tenantId });
      const deliveryId = randomUUID();
      const hook = (body: string) =>
        send(
          'POST',
          `/hooks/${wf.id}`,
          body,
          signedHeaders(wf.id, webhookSecret, body, deliveryId),
        );
      expect((await hook(text)).status).toBe(400);
      expect(await ds.getRepository(Execution).count()).toBe(0);
      // Відправник виправляє тіло й повторює ту саму доставку: вона приймається один раз.
      expect((await hook('{"amount":1}')).status).toBe(202);
      expect(await ds.getRepository(Execution).find()).toEqual([
        expect.objectContaining({ input: { amount: 1 } }),
      ]);
    },
  );

  // Значення, які без перевірки тихо ставали б 1000 і 100 і проходили валідацію полів.
  it('closes the whole class: other JSON routes reject inexact numbers too', async () => {
    const workflow = await send(
      'POST',
      '/workflows',
      '{"name":"wf","steps":[{"id":"wait","type":"delay","ms":1000.0000000000000000001}]}',
    );
    expect(workflow.status).toBe(400);
    expect(await ds.getRepository(Workflow).count()).toBe(0);
    const limits = await send(
      'PATCH',
      `/tenants/${tenantId}/limits`,
      '{"maxQueueSize":100.00000000000000000001}',
      { 'x-admin-token': TEST_ADMIN_TOKEN },
    );
    expect(limits.status).toBe(400);
  });

  /** Тіло в іншому кодуванні: перевірка бачила б не той текст, що розбір. */
  const encoded = (charset: string, bytes: Buffer, wfId: string) =>
    fetch(`${apiApp.baseUrl}/workflows/${wfId}/run`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'content-type': `application/json; charset=${charset}`,
      },
      body: new Uint8Array(bytes),
    });

  it.each([
    // UTF-16BE без BOM з міткою utf-16: body-parser вгадує BE, TextDecoder читав би LE.
    ['utf-16', Buffer.from('{"amount":1e400}', 'utf16le').swap16()],
    ['utf-16be', Buffer.from('{"amount":1}', 'utf16le').swap16()],
    ['utf-16le', Buffer.from('{"amount":1}', 'utf16le')],
    ['utf-32le', Buffer.from('{"amount":1}', 'utf16le')],
  ])(
    'rejects a JSON body in %s (415) and creates nothing',
    async (charset, bytes) => {
      const wf = await createWorkflow(ds, tenantId);
      const res = await encoded(charset, bytes, wf.id);
      expect(res.status).toBe(415);
      expect(await ds.getRepository(Execution).count()).toBe(0);
    },
  );

  it.each(['utf-8', 'UTF-8'])(
    'accepts a JSON body labelled %s',
    async (charset) => {
      const wf = await createWorkflow(ds, tenantId);
      const res = await encoded(charset, Buffer.from('{"amount":1}'), wf.id);
      expect(res.status).toBe(201);
    },
  );

  // Невалідні байти UTF-8: body-parser мовчки замінив би їх на U+FFFD.
  const invalidUtf8: Array<[string, Buffer]> = [
    [
      'a lone 0xFF byte in a string',
      Buffer.concat([
        Buffer.from('{"label":"'),
        Buffer.from([0xff]),
        Buffer.from('"}'),
      ]),
    ],
    [
      'a truncated multibyte sequence',
      Buffer.concat([
        Buffer.from('{"label":"'),
        Buffer.from([0xe2, 0x82]),
        Buffer.from('"}'),
      ]),
    ],
    [
      'a UTF-8-encoded lone surrogate',
      Buffer.concat([
        Buffer.from('{"label":"'),
        Buffer.from([0xed, 0xa0, 0x80]),
        Buffer.from('"}'),
      ]),
    ],
  ];

  it.each(invalidUtf8)(
    'rejects a manual run with %s (400) and creates nothing',
    async (_case, bytes) => {
      const wf = await createWorkflow(ds, tenantId);
      const res = await encoded('utf-8', bytes, wf.id);
      expect(res.status).toBe(400);
      expect(await ds.getRepository(Execution).count()).toBe(0);
    },
  );

  it('rejects a workflow whose name has an invalid UTF-8 byte (400)', async () => {
    const res = await fetch(`${apiApp.baseUrl}/workflows`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
      body: new Uint8Array(
        Buffer.concat([
          Buffer.from('{"name":"w'),
          Buffer.from([0xff]),
          Buffer.from('","steps":[{"id":"s","type":"log","message":"x"}]}'),
        ]),
      ),
    });
    expect(res.status).toBe(400);
    expect(await ds.getRepository(Workflow).count()).toBe(0);
  });

  it('authenticates before rejecting invalid UTF-8: no key gives 401', async () => {
    const wf = await createWorkflow(ds, tenantId);
    const res = await fetch(`${apiApp.baseUrl}/workflows/${wf.id}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: new Uint8Array(invalidUtf8[0][1]),
    });
    expect(res.status).toBe(401);
  });

  it('accepts a body with a UTF-8 BOM and multibyte text unchanged', async () => {
    const wf = await createWorkflow(ds, tenantId);
    const res = await encoded(
      'utf-8',
      Buffer.from('﻿{"label":"Київ 😀"}'),
      wf.id,
    );
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(
      (await ds.getRepository(Execution).findOneByOrFail({ id })).input,
    ).toEqual({ label: 'Київ 😀' });
  });
});
