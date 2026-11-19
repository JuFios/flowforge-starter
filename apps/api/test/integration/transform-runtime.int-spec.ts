import { DataSource } from 'typeorm';
import { Execution, Job, StepRun } from '../../src/entities';
import { openTestDataSource, truncateAll, createTenant } from '../helpers/db';
import { api, startWorker, waitFor } from '../helpers/queue';
import { RunningApp, startApp } from '../helpers/app';

describe('transform checkpoint and recovery', () => {
  let db: DataSource, server: RunningApp, worker: RunningApp | undefined;
  beforeAll(async () => {
    db = await openTestDataSource();
    await truncateAll(db);
    server = await startApp();
  });
  afterAll(async () => {
    await worker?.close();
    await server.close();
    await db.destroy();
  });
  it('records a permanent expression error once and completes the following job on the same worker', async () => {
    const { apiKey } = await createTenant(db);
    const make = async (expr: string, input: Record<string, unknown>) => {
      const wf = await api<{ id: string }>(
        server.baseUrl,
        apiKey,
        'POST',
        '/workflows',
        {
          name: 'shape',
          steps: [
            { id: 'first', type: 'log', message: 'ready' },
            { id: 'shape', type: 'transform', expr },
          ],
        },
      );
      expect(wf.status).toBe(201);
      const run = await api<{ id: string }>(
        server.baseUrl,
        apiKey,
        'POST',
        '/workflows/' + wf.body.id + '/run',
        input,
      );
      expect(run.status).toBe(201);
      return run.body.id;
    };
    const bad = await make('{"longer": [input.data, input.data]}', {
      data: 'x'.repeat(34000),
    });
    const ok = await make('{"value":input.n*2}', { n: 21 });
    worker = await startWorker(1);
    await waitFor(
      'the second job to finish',
      async () =>
        (await db.getRepository(Execution).findOneByOrFail({ id: ok }))
          .status === 'succeeded',
    );
    expect(
      await db.getRepository(Execution).findOneByOrFail({ id: ok }),
    ).toMatchObject({ output: { value: 42 } });
    expect(
      await db.getRepository(Job).findOneByOrFail({ executionId: bad }),
    ).toMatchObject({ status: 'failed', attempts: 1 });
    expect(
      await db.getRepository(StepRun).findBy({ executionId: bad }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepId: 'first',
          status: 'succeeded',
          attempts: 1,
        }),
        expect.objectContaining({
          stepId: 'shape',
          status: 'failed',
          attempts: 1,
        }),
      ]),
    );
  });
});
