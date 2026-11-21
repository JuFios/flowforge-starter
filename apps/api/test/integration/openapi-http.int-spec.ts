import type {
  OpenAPIObject,
  OperationObject,
  SchemaObject,
} from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildDocument } from '../../src/openapi/document';
import { SchedulerService } from '../../src/scheduler/scheduler.service';
import { RunningApp, startApp } from '../helpers/app';
import { openTestDataSource, truncateAll } from '../helpers/db';
import { Receiver } from '../helpers/queue';
import { TEST_ADMIN_TOKEN } from '../helpers/test-env';
import { signedHeaders } from '../helpers/webhook';

interface Observed {
  operation: string;
  status: number;
  headers: Headers;
  body: unknown;
}

/**
 * ТЗ 7: OpenAPI відповідає фактичному HTTP. Тест проходить справжні гілки кожного маршруту
 * (успіх, повтор, валідація, автентифікація, відсутній ресурс, конфлікт, межа тіла, кодування) і
 * для кожної відповіді перевіряє, що статус задекларовано для цієї операції, тіло відповідає
 * задекларованій схемі, а задекларовані заголовки присутні. Кожна задокументована операція має
 * хоча б одну перевірену гілку, тож новий маршрут без перевірки фактичних статусів не пройде.
 */
describe('OpenAPI matches the actual HTTP responses', () => {
  let ds: DataSource;
  let app: RunningApp;
  let doc: OpenAPIObject;
  const receiver = new Receiver();
  const observed: Observed[] = [];

  beforeAll(async () => {
    ds = await openTestDataSource();
    await truncateAll(ds);
    await receiver.start();
    app = await startApp();
    app.app.get(SchedulerService).onApplicationShutdown();
    doc = buildDocument(app.app);
  });
  afterAll(async () => {
    await app.close();
    await receiver.stop();
    await truncateAll(ds);
    await ds.destroy();
  });

  /** Надсилає запит і запам'ятовує відповідь разом з операцією документа (`method /template`). */
  async function send(
    operation: string,
    path: string,
    init: {
      headers?: Record<string, string>;
      body?: unknown;
      raw?: string;
    } = {},
  ): Promise<Observed> {
    const [method] = operation.split(' ');
    const res = await fetch(app.baseUrl + path, {
      method: method.toUpperCase(),
      headers: {
        ...(init.body !== undefined || init.raw !== undefined
          ? { 'content-type': 'application/json' }
          : {}),
        ...init.headers,
      },
      body:
        init.raw ??
        (init.body === undefined ? undefined : JSON.stringify(init.body)),
    });
    const text = await res.text();
    let body: unknown = undefined;
    if (text)
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    const result = {
      operation,
      status: res.status,
      headers: res.headers,
      body,
    };
    observed.push(result);
    return result;
  }

  function resolve(schema: SchemaObject): SchemaObject {
    const ref = (schema as { $ref?: string }).$ref;
    if (!ref) return schema;
    const name = ref.replace('#/components/schemas/', '');
    return doc.components!.schemas![name] as SchemaObject;
  }

  /** Відхилення значення від схеми (обов'язкові поля, типи, enum, закриті об'єкти). */
  function violations(value: unknown, raw: SchemaObject, at = '$'): string[] {
    const schema = resolve(raw);
    if (value === null)
      return schema.nullable ? [] : [`${at}: null is not allowed`];
    if (schema.oneOf)
      return schema.oneOf.some(
        (s) => violations(value, s as SchemaObject, at).length === 0,
      )
        ? []
        : [`${at}: matches no alternative`];
    if (schema.enum && !schema.enum.includes(value))
      return [`${at}: ${JSON.stringify(value)} is not in the enum`];
    switch (schema.type) {
      case 'string':
        return typeof value === 'string' ? [] : [`${at}: expected a string`];
      case 'integer':
        return Number.isInteger(value) ? [] : [`${at}: expected an integer`];
      case 'number':
        return typeof value === 'number' ? [] : [`${at}: expected a number`];
      case 'boolean':
        return typeof value === 'boolean' ? [] : [`${at}: expected a boolean`];
      case 'array':
        return Array.isArray(value)
          ? value.flatMap((v, i) =>
              violations(v, schema.items as SchemaObject, `${at}[${i}]`),
            )
          : [`${at}: expected an array`];
      case 'object': {
        if (typeof value !== 'object' || Array.isArray(value))
          return [`${at}: expected an object`];
        const record = value as Record<string, unknown>;
        const props = (schema.properties ?? {}) as Record<string, SchemaObject>;
        const out = (schema.required ?? [])
          .filter((k) => !(k in record))
          .map((k) => `${at}.${k}: required`);
        for (const [k, v] of Object.entries(record)) {
          if (props[k]) out.push(...violations(v, props[k], `${at}.${k}`));
          else if (schema.additionalProperties === false)
            out.push(`${at}.${k}: not declared`);
        }
        return out;
      }
      default:
        return [];
    }
  }

  function checkAgainstDocument(o: Observed): string[] {
    const [method, path] = o.operation.split(' ');
    const op = (
      doc.paths[path] as Record<string, OperationObject> | undefined
    )?.[method];
    if (!op) return [`${o.operation}: not documented`];
    const response = op.responses[String(o.status)] as
      | {
          content?: Record<string, { schema: SchemaObject }>;
          headers?: Record<string, unknown>;
        }
      | undefined;
    if (!response) return [`${o.operation}: status ${o.status} not declared`];
    const problems: string[] = [];
    const schema = response.content?.['application/json']?.schema;
    if (schema && o.body === undefined)
      problems.push(`${o.operation} ${o.status}: body expected`);
    if (schema && o.body !== undefined)
      problems.push(
        ...violations(o.body, schema).map(
          (v) => `${o.operation} ${o.status}: ${v}`,
        ),
      );
    if (!schema && o.body !== undefined && o.status !== 204)
      problems.push(`${o.operation} ${o.status}: undeclared body`);
    for (const header of Object.keys(response.headers ?? {})) {
      if (header === 'Retry-After') {
        const error = (o.body as { error?: string } | undefined)?.error;
        if (error === 'rate_limited' && !o.headers.get(header))
          problems.push(`${o.operation} ${o.status}: missing ${header}`);
        continue;
      }
      // Заголовки ліміту частоти несе кожна відповідь під лімітом (автентифікований запит).
      if (header.startsWith('X-RateLimit-') && o.status === 401) continue;
      if (!o.headers.get(header))
        problems.push(`${o.operation} ${o.status}: missing ${header}`);
    }
    return problems;
  }

  it('declares every status, body and header the routes actually return', async () => {
    const admin = { 'x-admin-token': TEST_ADMIN_TOKEN };
    // Тенанти: успіх, валідація, токен, межа й кодування тіла.
    const tenantRes = await send('post /tenants', '/tenants', {
      headers: admin,
      body: { name: 'contract' },
    });
    expect(tenantRes.status).toBe(201);
    const created = tenantRes.body as {
      id: string;
      apiKey: string;
      webhookSecret: string;
    };
    const tenantId = created.id;
    await send('post /tenants', '/tenants', {
      headers: admin,
      body: { name: 'x' },
    });
    await send('post /tenants', '/tenants', {
      headers: admin,
      body: { name: 'extra', apiKey: 'ff_x' },
    });
    await send('post /tenants', '/tenants', {
      headers: { 'x-admin-token': 'wrong-token-0123456789' },
      body: { name: 'denied' },
    });
    await send('post /tenants', '/tenants', {
      headers: admin,
      raw: JSON.stringify({ name: 'x'.repeat(2 * 1024 * 1024) }),
    });
    await send('post /tenants', '/tenants', {
      headers: { ...admin, 'content-encoding': 'gzip' },
      raw: '{}',
    });
    await send('post /tenants', '/tenants', { headers: admin, raw: '{"a":' });
    await send('get /tenants/{id}/limits', `/tenants/${tenantId}/limits`, {
      headers: admin,
    });
    await send('get /tenants/{id}/limits', `/tenants/${randomUUID()}/limits`, {
      headers: admin,
    });
    await send('get /tenants/{id}/limits', '/tenants/not-a-uuid/limits', {
      headers: admin,
    });
    await send('patch /tenants/{id}/limits', `/tenants/${tenantId}/limits`, {
      headers: admin,
      body: { rateLimit: 10_000 },
    });
    await send('patch /tenants/{id}/limits', `/tenants/${tenantId}/limits`, {
      headers: admin,
      body: { rateLimit: 0 },
    });

    const key = { 'x-api-key': created.apiKey };
    // Workflow: створення, читання, список, редагування, конфлікт ревізії, видалення.
    await send('get /workflows', '/workflows', {});
    await send('get /workflows', '/workflows?limit=0', { headers: key });
    const wfRes = await send('post /workflows', '/workflows', {
      headers: key,
      body: {
        name: 'contract',
        steps: [{ id: 'say', type: 'log', message: 'hi' }],
      },
    });
    expect(wfRes.status).toBe(201);
    const wf = wfRes.body as { id: string; editRevision: string };
    await send('post /workflows', '/workflows', {
      headers: key,
      body: { name: 'x', steps: [] },
    });
    await send('get /workflows', '/workflows', { headers: key });
    await send('get /workflows/{id}', `/workflows/${wf.id}`, { headers: key });
    await send('get /workflows/{id}', `/workflows/${randomUUID()}`, {
      headers: key,
    });
    await send('patch /workflows/{id}', `/workflows/${wf.id}`, {
      headers: key,
      body: { name: 'renamed', editRevision: wf.editRevision },
    });
    await send('patch /workflows/{id}', `/workflows/${wf.id}`, {
      headers: key,
      body: { name: 'stale', editRevision: wf.editRevision },
    });

    // Запуск: новий, повтор із ключем, ключ з іншим входом, відсутній workflow, некоректний вхід.
    const run = await send(
      'post /workflows/{id}/run',
      `/workflows/${wf.id}/run`,
      {
        headers: { ...key, 'idempotency-key': 'contract-1' },
        body: { n: 1 },
      },
    );
    expect(run.status).toBe(201);
    const executionId = (run.body as { id: string }).id;
    await send('post /workflows/{id}/run', `/workflows/${wf.id}/run`, {
      headers: { ...key, 'idempotency-key': 'contract-1' },
      body: { n: 1 },
    });
    await send('post /workflows/{id}/run', `/workflows/${wf.id}/run`, {
      headers: { ...key, 'idempotency-key': 'contract-1' },
      body: { n: 2 },
    });
    await send('post /workflows/{id}/run', `/workflows/${randomUUID()}/run`, {
      headers: key,
      body: {},
    });
    await send('post /workflows/{id}/run', `/workflows/${wf.id}/run`, {
      headers: key,
      raw: '[1]',
    });

    // Виконання: список, деталі, знімок, крок, вихід, повтор (409, потім 202), тикет.
    await send('get /executions', '/executions', { headers: key });
    await send('get /executions', '/executions?cursor=bad', { headers: key });
    await send('get /executions/{id}', `/executions/${executionId}`, {
      headers: key,
    });
    await send('get /executions/{id}', `/executions/${randomUUID()}`, {
      headers: key,
    });
    await send(
      'get /executions/{id}/summary',
      `/executions/${executionId}/summary`,
      { headers: key },
    );
    await send(
      'get /executions/{id}/steps/{index}',
      `/executions/${executionId}/steps/0`,
      { headers: key },
    );
    await send(
      'get /executions/{id}/output',
      `/executions/${executionId}/output`,
      { headers: key },
    );
    await send(
      'post /executions/{id}/retry',
      `/executions/${executionId}/retry`,
      { headers: key },
    );
    await ds.query(
      `UPDATE executions SET status='failed', error='x', "finishedAt"=now() WHERE id=$1`,
      [executionId],
    );
    await ds.query(
      `UPDATE jobs SET status='dead', "finishedAt"=now() WHERE "executionId"=$1`,
      [executionId],
    );
    await send(
      'post /executions/{id}/retry',
      `/executions/${executionId}/retry`,
      { headers: key },
    );
    await send(
      'post /executions/{id}/realtime-tickets',
      `/executions/${executionId}/realtime-tickets`,
      { headers: key },
    );
    await send(
      'post /executions/{id}/realtime-tickets',
      `/executions/${randomUUID()}/realtime-tickets`,
      { headers: key },
    );

    // Сесії браузера.
    const sessionRes = await send('post /sessions', '/sessions', {
      headers: key,
    });
    const token = (sessionRes.body as { token: string }).token;
    await send('post /sessions', '/sessions', {
      headers: { 'x-api-key': 'ff_wrong' },
    });
    await send('delete /sessions/current', '/sessions/current', {
      headers: { authorization: 'Bearer ' + token },
    });
    await send('delete /sessions/current', '/sessions/current', {
      headers: { authorization: 'Bearer ' + token },
    });

    // Вхідні webhook-и: прийнято, той самий ID з іншим тілом, без підпису, невідомий workflow.
    await send('patch /workflows/{id}', `/workflows/${wf.id}`, {
      headers: key,
      body: { enabled: true },
    });
    const hookBody = '{"order":1}';
    const delivery = randomUUID();
    await send('post /hooks/{workflowId}', `/hooks/${wf.id}`, {
      headers: signedHeaders(wf.id, created.webhookSecret, hookBody, delivery),
      raw: hookBody,
    });
    await send('post /hooks/{workflowId}', `/hooks/${wf.id}`, {
      headers: signedHeaders(
        wf.id,
        created.webhookSecret,
        '{"order":2}',
        delivery,
      ),
      raw: '{"order":2}',
    });
    await send('post /hooks/{workflowId}', `/hooks/${wf.id}`, {
      raw: hookBody,
    });
    await send('post /hooks/{workflowId}', `/hooks/${randomUUID()}`, {
      raw: hookBody,
    });

    // Ключі вхідних webhook-ів.
    const keys = '/tenants/me/webhook-secrets';
    await send('get ' + keys, keys, { headers: key });
    const rotated = await send('post ' + keys, keys, { headers: key });
    await send('post ' + keys, keys, { headers: key });
    const nextKey = (rotated.body as { id: string }).id;
    await send('delete ' + keys + '/{keyId}', `${keys}/${nextKey}`, {
      headers: key,
    });
    const [{ webhookKeyId }] = await ds.query<Array<{ webhookKeyId: string }>>(
      'SELECT "webhookKeyId" FROM tenants WHERE id=$1',
      [tenantId],
    );
    await send('delete ' + keys + '/{keyId}', `${keys}/${webhookKeyId}`, {
      headers: key,
    });
    await send('delete ' + keys + '/{keyId}', `${keys}/${randomUUID()}`, {
      headers: key,
    });

    // Сповіщення: без налаштувань (404), налаштування, помилки, ротація, журнал, події.
    const notes = '/tenants/me/notifications';
    await send('get ' + notes, notes, { headers: key });
    await send('delete ' + notes, notes, { headers: key });
    await send('post ' + notes + '/secrets', notes + '/secrets', {
      headers: key,
    });
    await send(
      'delete ' + notes + '/secrets/{keyId}',
      `${notes}/secrets/${randomUUID()}`,
      { headers: key },
    );
    const url = receiver.url('/notify');
    await send('put ' + notes, notes, { headers: key, body: { url } });
    await send('put ' + notes, notes, { headers: key, body: { url } });
    await send('put ' + notes, notes, {
      headers: key,
      body: { url, secret: 'x'.repeat(64) },
    });
    await send('put ' + notes, notes, {
      headers: key,
      raw: JSON.stringify({ url: 'x'.repeat(2 * 1024 * 1024) }),
    });
    await send('get ' + notes, notes, { headers: key });
    await send('post ' + notes + '/secrets', notes + '/secrets', {
      headers: key,
    });
    await send('post ' + notes + '/secrets', notes + '/secrets', {
      headers: key,
    });
    const [{ secretKeyId }] = await ds.query<Array<{ secretKeyId: string }>>(
      'SELECT "secretKeyId" FROM notification_settings WHERE "tenantId"=$1',
      [tenantId],
    );
    await send(
      'delete ' + notes + '/secrets/{keyId}',
      `${notes}/secrets/${secretKeyId}`,
      { headers: key },
    );
    // Після відкликання поточного ключа наступний став поточним і останнім: його відкликання — 409.
    const [{ promotedKeyId }] = await ds.query<
      Array<{ promotedKeyId: string }>
    >(
      'SELECT "secretKeyId" AS "promotedKeyId" FROM notification_settings WHERE "tenantId"=$1',
      [tenantId],
    );
    await send(
      'delete ' + notes + '/secrets/{keyId}',
      `${notes}/secrets/${promotedKeyId}`,
      { headers: key },
    );
    // Подія завершення.
    await ds.query(
      `UPDATE executions SET status='succeeded', error=NULL, "finishedAt"=now() WHERE id=$1`,
      [executionId],
    );
    const [{ id: eventId }] = await ds.query<Array<{ id: string }>>(
      'SELECT id FROM outbox_events WHERE "tenantId"=$1 LIMIT 1',
      [tenantId],
    );
    await send('get ' + notes + '/events', notes + '/events', { headers: key });
    await send('get ' + notes + '/events', notes + '/events?status=bogus', {
      headers: key,
    });
    await send('get ' + notes + '/events/{id}', `${notes}/events/${eventId}`, {
      headers: key,
    });
    await send(
      'get ' + notes + '/events/{id}',
      `${notes}/events/${eventId}?limit=1`,
      { headers: key },
    );
    await send(
      'get ' + notes + '/events/{id}',
      `${notes}/events/${randomUUID()}`,
      { headers: key },
    );
    await send(
      'post ' + notes + '/events/{id}/redeliver',
      `${notes}/events/${eventId}/redeliver`,
      { headers: key },
    );
    await send(
      'post ' + notes + '/events/{id}/redeliver',
      `${notes}/events/${randomUUID()}/redeliver`,
      { headers: key },
    );
    await send('post ' + notes + '/events/discard', notes + '/events/discard', {
      headers: key,
    });
    await send('delete ' + notes, notes, { headers: key });

    await send('delete /workflows/{id}', `/workflows/${wf.id}`, {
      headers: key,
    });
    await send('delete /workflows/{id}', `/workflows/${wf.id}`, {
      headers: key,
    });
    await send('get /health', '/health');
    await send('get /ready', '/ready');

    const problems = observed.flatMap(checkAgainstDocument);
    expect(problems).toEqual([]);

    // Кожна задокументована операція перевірена хоча б однією фактичною відповіддю.
    const documented = Object.entries(doc.paths).flatMap(([path, item]) =>
      Object.keys(item).map((method) => `${method} ${path}`),
    );
    const exercised = new Set(observed.map((o) => o.operation));
    expect(documented.filter((op) => !exercised.has(op))).toEqual([]);
  });
});
