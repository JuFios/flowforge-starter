import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { Execution, StepRun } from '../../src/entities';
import { RunningApp, startApp } from '../helpers/app';
import { createTenant, openTestDataSource, truncateAll } from '../helpers/db';
import { api, Receiver, startWorker, waitFor } from '../helpers/queue';

describe('durable execution', () => {
  let ds: DataSource;
  let apiApp: RunningApp;
  let worker: RunningApp | undefined;
  const receiver = new Receiver();
  let apiKey: string;

  beforeAll(async () => {
    ds = await openTestDataSource();
    apiApp = await startApp(AppModule);
    await receiver.start();
  });

  beforeEach(async () => {
    await truncateAll(ds);
    ({ apiKey } = await createTenant(ds));
  });

  afterEach(async () => {
    await worker?.close();
    worker = undefined;
    receiver.requests.length = 0;
    receiver.respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    };
  });

  afterAll(async () => {
    await apiApp.close();
    await receiver.stop();
    await ds.destroy();
  });

  async function createWorkflow(steps: unknown[]): Promise<string> {
    const res = await api<{ id: string }>(
      apiApp.baseUrl,
      apiKey,
      'POST',
      '/workflows',
      { name: 'durable', steps },
    );
    expect(res.status).toBe(201);
    return res.body.id;
  }

  async function run(workflowId: string, input = {}): Promise<string> {
    const res = await api<{ id: string }>(
      apiApp.baseUrl,
      apiKey,
      'POST',
      `/workflows/${workflowId}/run`,
      input,
    );
    return res.body.id;
  }

  function finished(id: string) {
    return waitFor(`execution ${id} to finish`, async () => {
      const e = await ds.getRepository(Execution).findOneByOrFail({ id });
      return e.status === 'succeeded' || e.status === 'failed';
    });
  }

  it('resumes a retried execution from the first unfinished step without repeating completed ones', async () => {
    let flakyCalls = 0;
    receiver.respond = (req, res) => {
      if (req.path === '/flaky' && ++flakyCalls === 1) {
        res.writeHead(503).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ path: req.path }));
    };
    const wf = await createWorkflow([
      {
        id: 'charge',
        type: 'http',
        method: 'POST',
        url: receiver.url('/charge'),
      },
      {
        id: 'notify',
        type: 'http',
        method: 'POST',
        url: receiver.url('/flaky'),
      },
    ]);
    const id = await run(wf);
    worker = await startWorker(1);
    await finished(id);

    const execution = await ds.getRepository(Execution).findOneByOrFail({ id });
    expect(execution.status).toBe('succeeded');
    // Платіж (зовнішній ефект) — один раз, хоча задачу повторено.
    expect(receiver.hits('/charge')).toHaveLength(1);
    expect(receiver.hits('/flaky')).toHaveLength(2);
    const steps = await ds
      .getRepository(StepRun)
      .find({ where: { executionId: id }, order: { stepIndex: 'ASC' } });
    expect(steps.map((s) => [s.stepId, s.status])).toEqual([
      ['charge', 'succeeded'],
      ['notify', 'succeeded'],
    ]);
  });

  it('runs the workflow version that was current when the execution started', async () => {
    const wf = await createWorkflow([
      { id: 'call', type: 'http', url: receiver.url('/v1') },
    ]);
    const id = await run(wf);
    const patched = await api(
      apiApp.baseUrl,
      apiKey,
      'PATCH',
      `/workflows/${wf}`,
      { steps: [{ id: 'other', type: 'http', url: receiver.url('/v2') }] },
    );
    expect(patched.status).toBe(200);

    worker = await startWorker(1);
    await finished(id);

    expect(
      (await ds.getRepository(Execution).findOneByOrFail({ id })).status,
    ).toBe('succeeded');
    expect(receiver.hits('/v1')).toHaveLength(1);
    expect(receiver.hits('/v2')).toHaveLength(0);
  });

  it('finishes an execution whose workflow was deleted after it started', async () => {
    const wf = await createWorkflow([
      { id: 'call', type: 'http', url: receiver.url('/kept') },
    ]);
    const id = await run(wf);
    const deleted = await api(
      apiApp.baseUrl,
      apiKey,
      'DELETE',
      `/workflows/${wf}`,
    );
    expect(deleted.status).toBe(204);

    worker = await startWorker(1);
    await finished(id);

    expect(
      (await ds.getRepository(Execution).findOneByOrFail({ id })).status,
    ).toBe('succeeded');
    expect(receiver.hits('/kept')).toHaveLength(1);
  });
});
