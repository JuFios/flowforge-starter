import { signedHeaders } from '../helpers/webhook';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { Execution, Job, StepRun, Tenant } from '../../src/entities';
import { RunningApp, startApp } from '../helpers/app';
import {
  createTenant,
  createWorkflow,
  openTestDataSource,
  truncateAll,
} from '../helpers/db';
import { TEST_ADMIN_TOKEN } from '../helpers/test-env';
import { api, Receiver, startWorker, waitFor } from '../helpers/queue';

/** U+FFFD — символ заміни Unicode. */
const REPLACEMENT = '�';

/**
 * Postgres не зберігає U+0000 (ні в jsonb, ні в text) і одиночні сурогати (у jsonb). Такі рядки
 * приходять і від тенанта (тіло запиту), і від отримувача http-кроку.
 */
describe('strings Postgres cannot store', () => {
  let ds: DataSource;
  let apiApp: RunningApp;
  let worker: RunningApp | undefined;
  const receiver = new Receiver();
  let apiKey: string;
  let tenantId: string;

  beforeAll(async () => {
    ds = await openTestDataSource();
    apiApp = await startApp(AppModule);
    await receiver.start();
  });

  beforeEach(async () => {
    await truncateAll(ds);
    ({
      apiKey,
      tenant: { id: tenantId },
    } = await createTenant(ds));
  });

  afterEach(async () => {
    await worker?.close();
    worker = undefined;
    receiver.requests.length = 0;
  });

  afterAll(async () => {
    await apiApp.close();
    await receiver.stop();
    await ds.destroy();
  });

  const call = <T = unknown>(method: string, path: string, body?: unknown) =>
    api<T>(apiApp.baseUrl, apiKey, method, path, body);

  async function run(steps: unknown[]): Promise<string> {
    const wf = await call<{ id: string }>('POST', '/workflows', {
      name: 'text',
      steps,
    });
    const exe = await call<{ id: string }>(
      'POST',
      `/workflows/${wf.body.id}/run`,
      {},
    );
    return exe.body.id;
  }

  const finished = (id: string) =>
    waitFor('the execution to finish', async () =>
      ['succeeded', 'failed'].includes(
        (await ds.getRepository(Execution).findOneByOrFail({ id })).status,
      ),
    );

  describe('in a step result', () => {
    it.each<[string, string, string, unknown]>([
      [
        'a JSON response with U+0000 in a value and a key',
        'application/json',
        '{"text":"a\\u0000b","k\\u0000":1}',
        { text: `a${REPLACEMENT}b`, [`k${REPLACEMENT}`]: 1 },
      ],
      [
        'a JSON response with a lone surrogate',
        'application/json',
        '{"text":"a\\ud800b"}',
        { text: `a${REPLACEMENT}b` },
      ],
      [
        'a text response with a NUL byte',
        'text/plain',
        'a\u0000b',
        `a${REPLACEMENT}b`,
      ],
    ])(
      'checkpoints %s once, with U+FFFD in place of the character',
      async (_case, type, payload, expected) => {
        receiver.respond = (_req, res) =>
          void res.writeHead(200, { 'content-type': type }).end(payload);
        const id = await run([
          { id: 'call', type: 'http', url: receiver.url('/odd') },
        ]);
        worker = await startWorker(1);
        await finished(id);

        expect(receiver.hits('/odd')).toHaveLength(1);
        const execution = await ds
          .getRepository(Execution)
          .findOneByOrFail({ id });
        expect(execution).toMatchObject({
          status: 'succeeded',
          output: { status: 200, body: expected },
        });
        expect(
          await ds
            .getRepository(StepRun)
            .findOneByOrFail({ executionId: id, stepId: 'call' }),
        ).toMatchObject({
          status: 'succeeded',
          attempts: 1,
          output: { status: 200, body: expected },
        });
      },
    );

    it('stores a deeply nested successful POST result and sends the request once', async () => {
      const body = '{"x":'.repeat(2000) + '"ok\\u0000"' + '}'.repeat(2000);
      receiver.respond = (_req, res) =>
        void res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(body);
      const id = await run([
        {
          id: 'call',
          type: 'http',
          method: 'POST',
          url: receiver.url('/nested'),
        },
      ]);
      worker = await startWorker(1);
      await finished(id);
      const execution = await ds
        .getRepository(Execution)
        .findOneByOrFail({ id });
      expect(execution.status).toBe('succeeded');
      expect(receiver.hits('/nested')).toHaveLength(1);
      expect(JSON.stringify((execution.output as { body: unknown }).body)).toBe(
        body.replace('\\u0000', REPLACEMENT),
      );
    });

    it('records a step error that contains U+0000', async () => {
      // Текст помилки transform-виразу задає тенант.
      const id = await run([
        {
          id: 'shape',
          type: 'transform',
          expr: '(() => { throw new Error("bad\\u0000value") })()',
        },
      ]);
      worker = await startWorker(1);
      await finished(id);

      const execution = await ds
        .getRepository(Execution)
        .findOneByOrFail({ id });
      expect(execution).toMatchObject({
        status: 'failed',
        error: `transform: bad${REPLACEMENT}value`,
      });
      expect(
        await ds.getRepository(Job).findOneByOrFail({ executionId: id }),
      ).toMatchObject({ status: 'failed', attempts: 1 });
    });
  });

  describe('at the API boundary', () => {
    const unstorable: Array<[string, unknown]> = [
      ['U+0000 in a value', { a: 'x\u0000y' }],
      ['U+0000 in a key', { 'x\u0000': 1 }],
      ['a lone surrogate', { a: ['ok', { b: '\ud800' }] }],
    ];

    it.each(unstorable)(
      'rejects run input with %s (400)',
      async (_c, input) => {
        const wf = await createWorkflow(ds, tenantId);
        const res = await call('POST', `/workflows/${wf.id}/run`, input);
        expect(res.status).toBe(400);
        expect(await ds.getRepository(Execution).count()).toBe(0);
      },
    );

    it.each(unstorable)(
      'rejects signed webhook input with %s (400)',
      async (_c, input) => {
        const wf = await createWorkflow(ds, tenantId);
        const { webhookSecret } = await ds
          .getRepository(Tenant)
          .findOneByOrFail({ id: tenantId });
        const body = JSON.stringify(input);
        const res = await fetch(`${apiApp.baseUrl}/hooks/${wf.id}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...signedHeaders(wf.id, webhookSecret, body),
          },
          body,
        });
        expect(res.status).toBe(400);
      },
    );

    it.each<[string, Record<string, unknown>]>([
      [
        'a step field with U+0000',
        {
          name: 'wf',
          steps: [{ id: 'say', type: 'log', message: 'a\u0000b' }],
        },
      ],
      [
        'a step field with a lone surrogate',
        {
          name: 'wf',
          steps: [{ id: 'say', type: 'log', message: 'a\udc00b' }],
        },
      ],
      [
        'a name with U+0000',
        { name: 'w\u0000f', steps: [{ id: 'say', type: 'log', message: 'x' }] },
      ],
      [
        'a timezone with U+0000',
        {
          name: 'wf',
          timezone: 'UTC\u0000',
          steps: [{ id: 'say', type: 'log', message: 'x' }],
        },
      ],
    ])('rejects a workflow with %s (400)', async (_c, body) => {
      const res = await call('POST', '/workflows', body);
      expect(res.status).toBe(400);
    });

    it('rejects a workflow update with U+0000 in the name (400)', async () => {
      const wf = await createWorkflow(ds, tenantId);
      const res = await call('PATCH', `/workflows/${wf.id}`, {
        name: 'w\u0000f',
      });
      expect(res.status).toBe(400);
    });

    it('rejects a tenant name with U+0000 (400)', async () => {
      const res = await fetch(`${apiApp.baseUrl}/tenants`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-admin-token': TEST_ADMIN_TOKEN,
        },
        body: JSON.stringify({ name: 'acme\u0000' }),
      });
      expect(res.status).toBe(400);
    });
  });
});
