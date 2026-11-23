import type {
  OpenAPIObject,
  OperationObject,
  ResponseObject,
  SchemaObject,
} from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { DataSource } from 'typeorm';
import type { RunningApp } from '../helpers/app';
import {
  createExecution,
  createTenant,
  createWorkflow,
  openTestDataSource,
  truncateAll,
} from '../helpers/db';
import { openApiContract } from '../helpers/openapi-contract';
import { signedHeaders } from '../helpers/webhook';

/**
 * Коди `429`, які маршрут може повернути, крім `rate_limited` (його повертає кожен маршрут з
 * автентифікацією). Перелік складено за місцями в коді, що кидають ці відмови, незалежно від
 * документа.
 */
const ROUTE_LIMITS: Record<string, string[]> = {
  'post /workflows': ['workflow_limit_reached'],
  'post /workflows/{id}/run': ['queue_full', 'outbox_full'],
  'post /hooks/{workflowId}': ['queue_full', 'outbox_full'],
  'post /executions/{id}/retry': ['queue_full', 'outbox_full'],
  'post /tenants/me/notifications/events/{id}/redeliver': ['outbox_full'],
  'post /executions/{id}/realtime-tickets': ['ticket_limit'],
  'get /executions/{id}': ['detail_in_progress'],
};

/** Застосунок із власними лімітами за IP: конфігурація читається під час імпорту модуля. */
async function startWith(env: Record<string, string>): Promise<RunningApp> {
  const saved = Object.fromEntries(
    Object.keys(env).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, env);
  try {
    let app: RunningApp | undefined;
    await jest.isolateModulesAsync(async () => {
      const { startApp } = await import('../helpers/app');
      const { AppModule } = await import('../../src/app.module');
      const { SchedulerService } =
        await import('../../src/scheduler/scheduler.service');
      app = await startApp(AppModule, { openApi: true });
      // Без воркера й планувальника задачі лишаються в черзі: квоти стоять заповненими.
      app.app.get(SchedulerService).onApplicationShutdown();
    });
    return app!;
  } finally {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
}

/** Запит деталей, тіло якого клієнт не читає: віддача тримає місце тенанта. */
function heldDetail(
  baseUrl: string,
  apiKey: string,
  id: string,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = request(`${baseUrl}/executions/${id}`, {
      headers: { 'x-api-key': apiKey },
    });
    req.on('response', (res) => {
      res.pause();
      resolve(res);
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * ТЗ 7 і 3.3.4: відмова `429` кожного маршруту задокументована точно. Тест викликає кожен код
 * на кожному маршруті, що його повертає, і `rate_limited` для кожного виду ліміту, звіряє
 * відповіді з документом і вимагає, щоб схема `429` маршруту перелічувала саме його коди.
 */
describe('OpenAPI documents the 429 codes of each route', () => {
  let ds: DataSource;
  let app: RunningApp;
  let doc: OpenAPIObject;
  const held: IncomingMessage[] = [];
  const contract = openApiContract(
    () => app.baseUrl,
    () => doc,
  );
  const { observed, send, checkAgainstDocument, resolve } = contract;

  beforeAll(async () => {
    ds = await openTestDataSource();
    await truncateAll(ds);
    app = await startWith({
      ADMIN_RATE_LIMIT: '2',
      AUTH_FAILURE_RATE_LIMIT: '2',
    });
    doc = (await (
      await fetch(app.baseUrl + '/docs-json')
    ).json()) as OpenAPIObject;
  });
  afterAll(async () => {
    for (const res of held) res.destroy();
    await app.close();
    await truncateAll(ds);
    await ds.destroy();
  });

  /** Тенант з workflow і перевизначеннями лімітів, записаними напряму (без адмін-запитів). */
  async function tenant(limits: Record<string, number> = {}) {
    const { tenant: t, apiKey } = await createTenant(ds);
    for (const [column, value] of Object.entries(limits))
      await ds.query(`UPDATE tenants SET "${column}" = $2 WHERE id = $1`, [
        t.id,
        value,
      ]);
    const wf = await createWorkflow(ds, t.id);
    return { t, wf, key: { 'x-api-key': apiKey }, apiKey };
  }

  function hook(workflowId: string, secret: string) {
    const raw = '{"order":"demo"}';
    return {
      headers: signedHeaders(workflowId, secret, raw),
      raw,
    };
  }

  /** Коди `error` у схемі відповіді `429` операції (порожньо, якщо схема їх не перелічує). */
  function documentedCodes(operation: string): string[] | undefined {
    const [method, path] = operation.split(' ');
    const op = (doc.paths[path] as Record<string, OperationObject>)[method];
    const response = op.responses['429'] as ResponseObject | undefined;
    if (!response) return undefined;
    const schema = resolve(
      response.content!['application/json'].schema as SchemaObject,
    );
    const error = schema.properties?.error as SchemaObject | undefined;
    return (error?.enum as string[] | undefined) ?? [];
  }

  it('lists exactly the 429 codes each route can return', () => {
    const problems: string[] = [];
    for (const [path, item] of Object.entries(doc.paths))
      for (const [method, op] of Object.entries(
        item as Record<string, OperationObject>,
      )) {
        const operation = `${method} ${path}`;
        const authenticated = (op.security ?? []).length > 0;
        const expected = authenticated
          ? ['rate_limited', ...(ROUTE_LIMITS[operation] ?? [])].sort()
          : undefined;
        const actual = documentedCodes(operation)?.slice().sort();
        if (JSON.stringify(actual) !== JSON.stringify(expected))
          problems.push(
            `${operation}: documents ${JSON.stringify(actual)}, returns ${JSON.stringify(expected)}`,
          );
      }
    expect(problems).toEqual([]);
  });

  it('returns only documented 429 bodies and headers on every limit', async () => {
    // Квота workflow.
    const quota = await tenant({ maxWorkflows: 1 });
    const steps = [{ id: 'say', type: 'log', message: 'hi' }];
    await send('post /workflows', '/workflows', 429, {
      headers: quota.key,
      body: { name: 'second', steps },
    });

    // Повна черга: запуск, webhook і повтор.
    const queue = await tenant({ maxQueueSize: 1 });
    await send(
      'post /workflows/{id}/run',
      `/workflows/${queue.wf.id}/run`,
      201,
      {
        headers: queue.key,
        body: {},
      },
    );
    await send(
      'post /workflows/{id}/run',
      `/workflows/${queue.wf.id}/run`,
      429,
      {
        headers: queue.key,
        body: {},
      },
    );
    await send(
      'post /hooks/{workflowId}',
      `/hooks/${queue.wf.id}`,
      429,
      hook(queue.wf.id, queue.t.webhookSecret),
    );
    const failedInQueue = await createExecution(ds, queue.wf, {
      status: 'failed',
    });
    await send(
      'post /executions/{id}/retry',
      `/executions/${failedInQueue.id}/retry`,
      429,
      { headers: queue.key },
    );

    // Повна квота outbox: запуск, webhook, повтор і повторна доставка.
    const outbox = await tenant({ maxOutboxEvents: 1 });
    await send(
      'post /workflows/{id}/run',
      `/workflows/${outbox.wf.id}/run`,
      201,
      { headers: outbox.key, body: {} },
    );
    await send(
      'post /workflows/{id}/run',
      `/workflows/${outbox.wf.id}/run`,
      429,
      { headers: outbox.key, body: {} },
    );
    await send(
      'post /hooks/{workflowId}',
      `/hooks/${outbox.wf.id}`,
      429,
      hook(outbox.wf.id, outbox.t.webhookSecret),
    );
    const failedInOutbox = await createExecution(ds, outbox.wf, {
      status: 'failed',
    });
    await send(
      'post /executions/{id}/retry',
      `/executions/${failedInOutbox.id}/retry`,
      429,
      { headers: outbox.key },
    );
    const [event] = await ds.query<Array<{ id: string }>>(
      `INSERT INTO outbox_events ("tenantId","executionId",sequence,type,payload,status,"cancelledAt")
       VALUES ($1, $2, 1, 'execution.failed', '{}', 'cancelled', now()) RETURNING id`,
      [outbox.t.id, failedInOutbox.id],
    );
    await send(
      'post /tenants/me/notifications/events/{id}/redeliver',
      `/tenants/me/notifications/events/${event.id}/redeliver`,
      429,
      { headers: outbox.key },
    );

    // Ліміт одночасних тикетів WebSocket.
    const tickets = await tenant();
    const watched = await createExecution(ds, tickets.wf);
    await ds.query(
      `INSERT INTO realtime_tickets ("tenantId","executionId","tokenHash","expiresAt")
       SELECT $1, $2, sha256(convert_to(random()::text || i, 'UTF8')), now() + interval '1 hour'
         FROM generate_series(1, 100) AS i`,
      [tickets.t.id, watched.id],
    );
    await send(
      'post /executions/{id}/realtime-tickets',
      `/executions/${watched.id}/realtime-tickets`,
      429,
      { headers: tickets.key },
    );

    // Повні деталі: тенант уже читає великий знімок.
    const reader = await tenant();
    const big = await createExecution(ds, reader.wf);
    await ds.query(
      `INSERT INTO step_runs ("executionId","tenantId","stepIndex","stepId",status,attempts,output)
       SELECT $1, $2, i, 's' || i, 'succeeded', 1, jsonb_build_object('body', repeat('x', 1000000))
         FROM generate_series(0, 7) AS i`,
      [big.id, reader.t.id],
    );
    const first = await heldDetail(app.baseUrl, reader.apiKey, big.id);
    held.push(first);
    expect(first.statusCode).toBe(200);
    await send('get /executions/{id}', `/executions/${big.id}`, 429, {
      headers: reader.key,
    });
    first.destroy();

    // Ліміт частоти API тенанта.
    const busy = await tenant({ rateLimit: 1 });
    await send('get /workflows', '/workflows', 200, { headers: busy.key });
    await send('get /workflows', '/workflows', 429, { headers: busy.key });

    // Ліміт частоти webhook-ів тенанта.
    const hooks = await tenant({ webhookRateLimit: 1 });
    await send(
      'post /hooks/{workflowId}',
      `/hooks/${hooks.wf.id}`,
      202,
      hook(hooks.wf.id, hooks.t.webhookSecret),
    );
    await send(
      'post /hooks/{workflowId}',
      `/hooks/${hooks.wf.id}`,
      429,
      hook(hooks.wf.id, hooks.t.webhookSecret),
    );

    // Окрема квота відкликання сесій: 60 за хвилину на тенанта.
    const sessions = await tenant();
    const tokens: string[] = [];
    for (let i = 0; i < 61; i++) {
      const res = await fetch(app.baseUrl + '/sessions', {
        method: 'POST',
        headers: sessions.key,
      });
      expect(res.status).toBe(201);
      tokens.push(((await res.json()) as { token: string }).token);
    }
    for (const [i, token] of tokens.entries())
      await send(
        'delete /sessions/current',
        '/sessions/current',
        i < 60 ? 204 : 429,
        { headers: { authorization: `Bearer ${token}` } },
      );

    // Ліміти за IP (у цьому застосунку — по 2): адмін-ендпоінти й невдалі автентифікації.
    const admin = { 'x-admin-token': process.env.ADMIN_TOKEN! };
    const limitsPath = `/tenants/${busy.t.id}/limits`;
    await send('get /tenants/{id}/limits', limitsPath, 200, { headers: admin });
    await send('get /tenants/{id}/limits', limitsPath, 200, { headers: admin });
    await send('get /tenants/{id}/limits', limitsPath, 429, { headers: admin });
    const wrong = { 'x-api-key': `ff_${randomBytes(24).toString('hex')}` };
    await send('get /workflows', '/workflows', 401, { headers: wrong });
    await send('get /workflows', '/workflows', 401, { headers: wrong });
    await send('get /workflows', '/workflows', 429, { headers: wrong });

    expect(observed.flatMap(checkAgainstDocument)).toEqual([]);
    // Кожна відмова мала код, який документ перелічує саме для цього маршруту.
    const undeclared = observed
      .filter((o) => o.status === 429)
      .map((o) => ({
        operation: o.operation,
        error: (o.body as { error?: string }).error!,
      }))
      .filter(
        ({ operation, error }) =>
          !(documentedCodes(operation) ?? []).includes(error),
      );
    expect(undeclared).toEqual([]);
  });
});
