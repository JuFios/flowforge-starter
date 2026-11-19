import { signedHeaders } from '../helpers/webhook';
import { DataSource } from 'typeorm';
import { Execution, Job, StepRun } from '../../src/entities';
import { LimitsMetrics } from '../../src/limits/limits.metrics';
import { SchedulerService } from '../../src/scheduler/scheduler.service';
import { RunningApp, startApp } from '../helpers/app';
import { createTenant, openTestDataSource, truncateAll } from '../helpers/db';
import { Receiver, startWorker, waitFor } from '../helpers/queue';

/**
 * Ліміт черги тенанта (ТЗ 3.3.4): незавершених задач (`queued` + `running`, включно з паузами)
 * не більше за `maxQueueSize`. Діє на кожну постановку — запуск через API, webhook, cron і повтор —
 * атомарно з нею; повна черга — 429 `queue_full` без Retry-After, і нічого не створюється.
 */
describe('tenant queue size limit', () => {
  let owner: DataSource;
  let apiApp: RunningApp;
  const receiver = new Receiver();
  let tenant: { id: string; apiKey: string; webhookSecret: string };

  beforeAll(async () => {
    owner = await openTestDataSource();
    apiApp = await startApp();
    await receiver.start();
  });

  beforeEach(async () => {
    await truncateAll(owner);
    const created = await createTenant(owner);
    tenant = {
      id: created.tenant.id,
      apiKey: created.apiKey,
      webhookSecret: created.tenant.webhookSecret,
    };
    apiApp.app.get(LimitsMetrics).enqueueRejected.reset();
  });

  afterAll(async () => {
    await apiApp.close();
    await receiver.stop();
    await truncateAll(owner);
    await owner.destroy();
  });

  const setQueueSize = (size: number) =>
    owner.query(`UPDATE tenants SET "maxQueueSize" = $2 WHERE id = $1`, [
      tenant.id,
      size,
    ]);

  function call(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return fetch(`${apiApp.baseUrl}${path}`, {
      method,
      headers: {
        'x-api-key': tenant.apiKey,
        'content-type': 'application/json',
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function workflow(
    steps: unknown[] = [{ id: 'say', type: 'log', message: 'hi' }],
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await call('POST', '/workflows', {
      name: 'q',
      steps,
      ...extra,
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  const executions = () =>
    owner.getRepository(Execution).countBy({ tenantId: tenant.id });
  const jobs = () => owner.getRepository(Job).countBy({ tenantId: tenant.id });

  async function rejected(trigger: string): Promise<number> {
    const { values } = await apiApp.app
      .get(LimitsMetrics)
      .enqueueRejected.get();
    return (
      values.find(
        (v) => v.labels.trigger === trigger && v.labels.reason === 'queue_full',
      )?.value ?? 0
    );
  }

  it('answers queue_full with the request rate headers and without Retry-After', async () => {
    await setQueueSize(1);
    const wf = await workflow();
    expect((await call('POST', `/workflows/${wf}/run`, {})).status).toBe(201);
    const res = await call('POST', `/workflows/${wf}/run`, {});
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({
      statusCode: 429,
      error: 'queue_full',
    });
    expect(res.headers.get('retry-after')).toBeNull();
    expect(Number(res.headers.get('x-ratelimit-remaining'))).toBeGreaterThan(0);
    expect(await rejected('api')).toBe(1);
  });

  it('rejects a webhook beyond the queue size and creates nothing', async () => {
    await setQueueSize(1);
    const wf = await workflow();
    const hook = (body: unknown) =>
      fetch(`${apiApp.baseUrl}/hooks/${wf}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...signedHeaders(wf, tenant.webhookSecret, JSON.stringify(body)),
        },
        body: JSON.stringify(body),
      });
    expect((await hook({ n: 1 })).status).toBe(202);
    const res = await hook({ n: 2 });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: 'queue_full' });
    expect(await executions()).toBe(1);
    expect(await jobs()).toBe(1);
    expect(await rejected('webhook')).toBe(1);
  });

  it('skips a cron firing on a full queue, counts it and keeps the schedule going', async () => {
    await setQueueSize(1);
    await workflow(undefined, { cron: '* * * * * *' });
    const scheduler = apiApp.app.get(SchedulerService);
    // Три спрацювання за тік: перше займає єдине місце, наступне пропускається.
    expect(await scheduler.tick(new Date(Date.now() + 3_000))).toBe(1);
    expect(await executions()).toBe(1);
    expect(await rejected('cron')).toBe(1);
    // Місце звільнилось — наступний тік створює виконання.
    await owner.query(
      `UPDATE jobs SET status = 'done', "finishedAt" = now() WHERE "tenantId" = $1`,
      [tenant.id],
    );
    expect(await scheduler.tick(new Date(Date.now() + 4_000))).toBe(1);
    expect(await executions()).toBe(2);
  });

  it('admits exactly the queue size out of 20 concurrent runs', async () => {
    await setQueueSize(5);
    const wf = await workflow();
    const statuses = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        call('POST', `/workflows/${wf}/run`, { i }).then((r) => r.status),
      ),
    );
    expect(statuses.filter((s) => s === 201)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(15);
    expect(await executions()).toBe(5);
    expect(await jobs()).toBe(5);
  });

  it('answers 10 concurrent identical runs with one place left with one 201 and nine 200 of the same run', async () => {
    await setQueueSize(1);
    const wf = await workflow();
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        call(
          'POST',
          `/workflows/${wf}/run`,
          { same: true },
          { 'idempotency-key': 'one-place' },
        ),
      ),
    );
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([
      200, 200, 200, 200, 200, 200, 200, 200, 200, 201,
    ]);
    const ids = new Set(
      await Promise.all(
        responses.map(async (r) => ((await r.json()) as { id: string }).id),
      ),
    );
    expect(ids.size).toBe(1);
    expect(await executions()).toBe(1);
    expect(await jobs()).toBe(1);
    // Той самий ключ з іншим входом — 422, навіть коли черга повна.
    const other = await call(
      'POST',
      `/workflows/${wf}/run`,
      { same: false },
      { 'idempotency-key': 'one-place' },
    );
    expect(other.status).toBe(422);
  });

  it('counts parked delays as queued and keeps the queue when the limit is lowered', async () => {
    const wf = await workflow([
      { id: 'pause', type: 'delay', ms: 3_600_000 },
      { id: 'say', type: 'log', message: 'late' },
    ]);
    for (let i = 0; i < 3; i++)
      expect((await call('POST', `/workflows/${wf}/run`, { i })).status).toBe(
        201,
      );
    const worker = await startWorker(2);
    try {
      await waitFor(
        'every run to park on its delay',
        async () =>
          (await owner.getRepository(StepRun).countBy({
            tenantId: tenant.id,
            status: 'running',
          })) === 3,
      );
    } finally {
      await worker.close();
    }
    // Зниження нижче поточного використання: черга лишається, нові постановки — 429.
    await setQueueSize(2);
    expect(await jobs()).toBe(3);
    expect((await call('POST', `/workflows/${wf}/run`, {})).status).toBe(429);
  });

  it('rejects a retry on a full queue without touching the run, and continues it once a place frees up', async () => {
    let fail = true;
    receiver.respond = (_req, res) =>
      fail
        ? void res.writeHead(400).end()
        : void res
            .writeHead(200, { 'content-type': 'application/json' })
            .end('{}');
    const wf = await workflow([
      { id: 'say', type: 'log', message: 'first' },
      { id: 'call', type: 'http', url: receiver.url('/q') },
    ]);
    const run = (await (
      await call('POST', `/workflows/${wf}/run`, {})
    ).json()) as {
      id: string;
    };
    const worker = await startWorker(1);
    try {
      await waitFor(
        'the run to fail',
        async () =>
          (await owner.getRepository(Execution).findOneByOrFail({ id: run.id }))
            .status === 'failed',
      );
      // Черга зайнята іншим виконанням (ліміт 1): повтор — 429, стан і чекпоінти без змін.
      await setQueueSize(1);
      const blocker = await workflow([
        { id: 'pause', type: 'delay', ms: 3_600_000 },
      ]);
      expect((await call('POST', `/workflows/${blocker}/run`, {})).status).toBe(
        201,
      );
      const before = await owner.getRepository(StepRun).find({
        where: { executionId: run.id },
        order: { stepIndex: 'ASC' },
      });
      const res = await call('POST', `/executions/${run.id}/retry`);
      expect(res.status).toBe(429);
      expect(await res.json()).toMatchObject({ error: 'queue_full' });
      expect(await rejected('retry')).toBe(1);
      expect(
        await owner.getRepository(Execution).findOneByOrFail({ id: run.id }),
      ).toMatchObject({ status: 'failed' });
      expect(
        await owner.getRepository(StepRun).find({
          where: { executionId: run.id },
          order: { stepIndex: 'ASC' },
        }),
      ).toEqual(before);

      // Місце звільнилось: повтор продовжує з першого незавершеного кроку.
      await setQueueSize(10);
      fail = false;
      expect((await call('POST', `/executions/${run.id}/retry`)).status).toBe(
        202,
      );
      await waitFor(
        'the retried run to succeed',
        async () =>
          (await owner.getRepository(Execution).findOneByOrFail({ id: run.id }))
            .status === 'succeeded',
      );
      const say = await owner
        .getRepository(StepRun)
        .findOneByOrFail({ executionId: run.id, stepId: 'say' });
      expect(say.attempts).toBe(1);
    } finally {
      await worker.close();
    }
  });
});
