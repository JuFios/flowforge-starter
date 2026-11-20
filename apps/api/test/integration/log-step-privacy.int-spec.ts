import { DataSource } from 'typeorm';
import { AppModule, WorkerModule } from '../../src/app.module';
import { JobRunnerService } from '../../src/engine/job-runner.service';
import { Execution, StepRun } from '../../src/entities';
import { RunningApp, startApp } from '../helpers/app';
import { createTenant, openTestDataSource, truncateAll } from '../helpers/db';
import { api, Receiver, waitFor } from '../helpers/queue';

/**
 * Крок `log` (рішення користувача щодо ТЗ §4, беклог PR 6): відрендерений текст — дані тенанта.
 * Він зберігається в результаті кроку (`{ logged: true, message }`), а в операційний журнал
 * воркера йдуть лише службові ID, кореляція й довжина.
 */
describe('log step keeps tenant text out of the operator log', () => {
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
  });

  afterAll(async () => {
    await apiApp.close();
    await receiver.stop();
    await ds.destroy();
  });

  const call = <T = unknown>(
    key: string,
    method: string,
    path: string,
    body?: unknown,
  ) => api<T>(apiApp.baseUrl, key, method, path, body);

  async function startLoggedWorker(): Promise<RunningApp> {
    const app = await startApp(WorkerModule, { captureLogs: true });
    app.app.get(JobRunnerService).start(1);
    return app;
  }

  async function finished(id: string): Promise<Execution> {
    await waitFor('the execution to finish', async () =>
      ['succeeded', 'failed'].includes(
        (await ds.getRepository(Execution).findOneByOrFail({ id })).status,
      ),
    );
    return ds.getRepository(Execution).findOneByOrFail({ id });
  }

  it('stores the message from input and from a previous http response in the step result, not in the log', async () => {
    const inputMarker = `input-marker-${Date.now()}`;
    const responseMarker = `response-marker-${Date.now()}`;
    receiver.respond = (_req, res) =>
      void res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ token: responseMarker }));
    const wf = await call<{ id: string }>(apiKey, 'POST', '/workflows', {
      name: 'log',
      steps: [
        { id: 'call', type: 'http', url: receiver.url('/token') },
        {
          id: 'say',
          type: 'log',
          message: 'input={{ input.secret }} token={{ steps.call.body.token }}',
        },
      ],
    });
    const run = await call<{ id: string }>(
      apiKey,
      'POST',
      `/workflows/${wf.body.id}/run`,
      { secret: inputMarker },
    );
    worker = await startLoggedWorker();
    expect((await finished(run.body.id)).status).toBe('succeeded');

    const message = `input=${inputMarker} token=${responseMarker}`;
    const detail = await call<{
      steps: Array<{ stepId: string; output: unknown }>;
    }>(apiKey, 'GET', `/executions/${run.body.id}`);
    expect(detail.body.steps.find((s) => s.stepId === 'say')?.output).toEqual({
      logged: true,
      message,
    });

    const logText = JSON.stringify(worker.logs);
    expect(logText).not.toContain(inputMarker);
    expect(logText).not.toContain(responseMarker);
    const event = worker.logs.find(
      (line) => line.msg === 'log step recorded its message',
    );
    expect(event).toMatchObject({
      executionId: run.body.id,
      stepId: 'say',
      length: message.length,
    });
    expect(event?.tenantId).toEqual(expect.any(String));
    expect(event?.correlationId).toEqual(expect.any(String));

    // Інший тенант не бачить виконання й тексту.
    const other = await createTenant(ds, 'other');
    expect(
      (await call(other.apiKey, 'GET', `/executions/${run.body.id}`)).status,
    ).toBe(404);
  });

  it('logs a lone surrogate from a previous response as U+FFFD, the value the previous step stored', async () => {
    // Екранований одиночний сурогат: JSON.parse дає рядок, який jsonb не прийме. Чекпоінт http
    // зберігає U+FFFD, і крок log бачить саме збережене значення.
    receiver.respond = (_req, res) =>
      void res
        .writeHead(200, { 'content-type': 'application/json' })
        .end('{"t":"\\ud800x"}');
    const wf = await call<{ id: string }>(apiKey, 'POST', '/workflows', {
      name: 'surrogate',
      steps: [
        { id: 'call', type: 'http', url: receiver.url('/s') },
        { id: 'say', type: 'log', message: '[{{ steps.call.body.t }}]' },
      ],
    });
    const run = await call<{ id: string }>(
      apiKey,
      'POST',
      `/workflows/${wf.body.id}/run`,
      {},
    );
    worker = await startLoggedWorker();
    expect((await finished(run.body.id)).status).toBe('succeeded');
    const say = await ds
      .getRepository(StepRun)
      .findOneByOrFail({ executionId: run.body.id, stepId: 'say' });
    expect(say.output).toEqual({ logged: true, message: '[\uFFFDx]' });
  });

  it('keeps one stored result when the job is retried after the log checkpoint', async () => {
    const wf = await call<{ id: string }>(apiKey, 'POST', '/workflows', {
      name: 'checkpointed',
      steps: [
        { id: 'say', type: 'log', message: 'hello {{ input.name }}' },
        { id: 'call', type: 'http', url: receiver.url('/flaky') },
      ],
    });
    let calls = 0;
    receiver.respond = (_req, res) =>
      void res.writeHead(++calls === 1 ? 503 : 200).end('{}');
    const run = await call<{ id: string }>(
      apiKey,
      'POST',
      `/workflows/${wf.body.id}/run`,
      { name: 'Ada' },
    );
    worker = await startLoggedWorker();
    expect((await finished(run.body.id)).status).toBe('succeeded');
    const say = await ds
      .getRepository(StepRun)
      .findOneByOrFail({ executionId: run.body.id, stepId: 'say' });
    expect(say).toMatchObject({
      attempts: 1,
      output: { logged: true, message: 'hello Ada' },
    });
  });
});
