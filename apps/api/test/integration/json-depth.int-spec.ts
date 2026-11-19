import { signedHeaders } from '../helpers/webhook';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { Execution, Job, StepRun } from '../../src/entities';
import { RunningApp, startApp } from '../helpers/app';
import { createTenant, openTestDataSource, truncateAll } from '../helpers/db';
import { api, Receiver, startWorker, waitFor } from '../helpers/queue';

/** Об'єкт `{"a":{"a":…1…}}` із `depth` рівнями вкладеності — як текст (клієнт його не серіалізує). */
const nested = (depth: number) =>
  '{"a":'.repeat(depth) + '1' + '}'.repeat(depth);

/**
 * Глибина вкладеності JSON обмежена (MAX_JSON_DEPTH = 64): вхід, глибший за межу, — 400, а не
 * переповнення стеку рекурсивних обходів (JSON.stringify, перевірки символів) з відповіддю 500.
 * 3000 рівнів — 18 001 байт, 15 000 — 90 001 байт: обидва менші за ліміт тіла.
 */
describe('JSON nesting depth', () => {
  let ds: DataSource;
  let apiApp: RunningApp;
  let worker: RunningApp | undefined;
  const receiver = new Receiver();
  let apiKey: string;
  let secret: string;
  let workflowId: string;

  beforeAll(async () => {
    ds = await openTestDataSource();
    apiApp = await startApp(AppModule);
    await receiver.start();
  });

  beforeEach(async () => {
    await truncateAll(ds);
    const created = await createTenant(ds);
    apiKey = created.apiKey;
    secret = created.tenant.webhookSecret;
    workflowId = await createWorkflowViaApi([
      { id: 'say', type: 'log', message: 'hi' },
    ]);
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

  async function createWorkflowViaApi(steps: unknown[]): Promise<string> {
    const res = await api<{ id: string }>(
      apiApp.baseUrl,
      apiKey,
      'POST',
      '/workflows',
      { name: 'depth', steps },
    );
    expect(res.status).toBe(201);
    return res.body.id;
  }

  const post = (path: string, body: string, headers: Record<string, string>) =>
    fetch(`${apiApp.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });

  const runWith = (body: string, authenticated = true) =>
    post(
      `/workflows/${workflowId}/run`,
      body,
      authenticated ? { 'x-api-key': apiKey } : {},
    );

  const sign = (body: string) => signedHeaders(workflowId, secret, body);
  const deliver = (body: string, headers: Record<string, string> = {}) =>
    post(`/hooks/${workflowId}`, body, headers);

  it('accepts a run input nested exactly 64 levels deep', async () => {
    const res = await runWith(nested(64));
    expect(res.status).toBe(201);
  });

  it.each([65, 3000, 15_000])(
    'answers a run input nested %i levels deep with 400 and creates nothing',
    async (depth) => {
      const res = await runWith(nested(depth));
      expect(res.status).toBe(400);
      expect(await res.text()).toMatch(/64/);
      expect(await ds.getRepository(Execution).count()).toBe(0);
    },
  );

  it('checks the API key before the depth of the run input', async () => {
    const res = await runWith(nested(3000), false);
    expect(res.status).toBe(401);
  });

  it('answers a correctly signed webhook nested 3000 levels deep with 400', async () => {
    const body = nested(3000);
    const res = await deliver(body, sign(body));
    expect(res.status).toBe(400);
    expect(await ds.getRepository(Execution).count()).toBe(0);
  });

  it.each([3000, 15_000])(
    'answers an unsigned webhook nested %i levels deep with 401 and no details',
    async (depth) => {
      const res = await deliver(nested(depth));
      expect(res.status).toBe(401);
      // Лише текст помилки: випадковий correlationId (UUID) теж може містити «64».
      const { message } = (await res.json()) as { message: unknown };
      expect(JSON.stringify(message)).not.toMatch(/JSON|64|рівн/);
    },
  );

  it('validates depth after authenticating the original bytes', async () => {
    const body = nested(15_000);
    expect((await deliver(body, sign(body))).status).toBe(400);
  });

  it.each([
    ['a field of the workflow', `{"name":${nested(3000)},"steps":[]}`],
    [
      'a step definition',
      `{"name":"deep","steps":[{"id":"s","type":"log","message":"m","x":${nested(3000)}}]}`,
    ],
  ])('answers %s nested 3000 levels deep with 400', async (_case, body) => {
    const res = await post('/workflows', body, { 'x-api-key': apiKey });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/64/);
  });

  it('fails an http step without retries when the response JSON is nested deeper than 2048 levels', async () => {
    receiver.respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(nested(3000));
    };
    const deep = await createWorkflowViaApi([
      { id: 'fetch', type: 'http', url: receiver.url('/deep') },
    ]);
    const run = await api<{ id: string }>(
      apiApp.baseUrl,
      apiKey,
      'POST',
      `/workflows/${deep}/run`,
      {},
    );
    const id = run.body.id;
    worker = await startWorker(1);
    await waitFor(`execution ${id} to finish`, async () => {
      const e = await ds.getRepository(Execution).findOneByOrFail({ id });
      return e.status === 'failed' || e.status === 'succeeded';
    });
    const execution = await ds.getRepository(Execution).findOneByOrFail({ id });
    expect(execution).toMatchObject({ status: 'failed' });
    expect(execution.error).toMatch(/nested deeper than 2048/);
    expect(
      await ds.getRepository(Job).findOneByOrFail({ executionId: id }),
    ).toMatchObject({ status: 'failed' });
    expect(
      await ds.getRepository(StepRun).findOneByOrFail({ executionId: id }),
    ).toMatchObject({ status: 'failed' });
    expect(receiver.hits('/deep')).toHaveLength(1);
  });
});
