import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { Execution, StepRun } from '../../src/entities';
import { RunningApp, startApp } from '../helpers/app';
import { createTenant, openTestDataSource, truncateAll } from '../helpers/db';
import { api, Receiver, startWorker, waitFor } from '../helpers/queue';

/**
 * Текстова (не JSON) відповідь успішного http-кроку зберігається цілою в межах
 * HTTP_RESPONSE_BYTES: наступний крок бачить те саме, що надіслав отримувач.
 */
describe('http step: a text response is kept whole', () => {
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

  const call = <T = unknown>(method: string, path: string, body?: unknown) =>
    api<T>(apiApp.baseUrl, apiKey, method, path, body);

  it('passes a 50 000-character CSV to the next step unchanged', async () => {
    // Багатобайтовий символ поверх колишньої межі в 10 000 кодових одиниць.
    const text =
      'id,name\n'.padEnd(9_999, 'x') + '😀' + 'tail,'.repeat(8_000) + 'end';
    expect(text.length).toBeGreaterThan(40_000);
    receiver.respond = (_req, res) =>
      void res
        .writeHead(200, { 'content-type': 'text/csv; charset=utf-8' })
        .end(text);
    const wf = await call<{ id: string }>('POST', '/workflows', {
      name: 'csv',
      steps: [
        { id: 'call', type: 'http', url: receiver.url('/export.csv') },
        { id: 'copy', type: 'transform', expr: 'steps.call.body' },
      ],
    });
    const exe = await call<{ id: string }>(
      'POST',
      `/workflows/${wf.body.id}/run`,
      {},
    );
    worker = await startWorker(1);
    await waitFor('the execution to finish', async () =>
      ['succeeded', 'failed'].includes(
        (await ds.getRepository(Execution).findOneByOrFail({ id: exe.body.id }))
          .status,
      ),
    );

    const step = await ds
      .getRepository(StepRun)
      .findOneByOrFail({ executionId: exe.body.id, stepId: 'call' });
    expect(step).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect((step.output as { body: string }).body).toBe(text);
    const execution = await ds
      .getRepository(Execution)
      .findOneByOrFail({ id: exe.body.id });
    expect(execution).toMatchObject({ status: 'succeeded', output: text });
    expect(receiver.hits('/export.csv')).toHaveLength(1);
  });
});
