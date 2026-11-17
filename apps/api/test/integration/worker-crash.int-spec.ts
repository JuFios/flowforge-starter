import { ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { Execution, StepRun } from '../../src/entities';
import { RunningApp, startApp } from '../helpers/app';
import { createTenant, openTestDataSource, truncateAll } from '../helpers/db';
import { api, Receiver, startWorker, waitFor } from '../helpers/queue';

/** Зібраний воркер (npm run build виконує pretest:integration). */
const WORKER_ENTRY = join(__dirname, '../../dist/worker.js');

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * Справжнє аварійне завершення: воркер — окремий процес, його вбиває SIGKILL посеред кроку
 * (без graceful shutdown, без жодного запису після сигналу).
 */
describe('a worker killed in the middle of a step', () => {
  let ds: DataSource;
  let apiApp: RunningApp;
  let child: ChildProcess | undefined;
  let rescuer: RunningApp | undefined;
  const receiver = new Receiver();

  beforeAll(async () => {
    if (!existsSync(WORKER_ENTRY))
      throw new Error(`${WORKER_ENTRY} is missing: run npm run build first`);
    ds = await openTestDataSource();
    await truncateAll(ds);
    apiApp = await startApp(AppModule);
    await receiver.start();
  });

  afterAll(async () => {
    child?.kill('SIGKILL');
    await rescuer?.close();
    await apiApp.close();
    await receiver.stop();
    await ds.destroy();
  });

  it('is picked up by another worker; completed steps are not repeated and the side effect happens once', async () => {
    // Отримувач поважає Idempotency-Key: ефект («відвантаження») — один на ключ.
    const shipped = new Set<string>();
    let hold = true;
    receiver.respond = (req, res) => {
      if (req.path === '/ship') {
        const key = String(req.headers['idempotency-key']);
        shipped.add(key);
        // Перший запит «зависає», поки воркер не вб'ють; повтор відповідає одразу.
        if (hold) return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    };
    const { apiKey } = await createTenant(ds);
    const wf = await api<{ id: string }>(
      apiApp.baseUrl,
      apiKey,
      'POST',
      '/workflows',
      {
        name: 'crash',
        steps: [
          {
            id: 'charge',
            type: 'http',
            method: 'POST',
            url: receiver.url('/charge'),
          },
          {
            id: 'ship',
            type: 'http',
            method: 'POST',
            url: receiver.url('/ship'),
          },
          { id: 'done', type: 'log', message: 'finished' },
        ],
      },
    );
    const id = (
      await api<{ id: string }>(
        apiApp.baseUrl,
        apiKey,
        'POST',
        `/workflows/${wf.body.id}/run`,
        {},
      )
    ).body.id;

    child = spawn(process.execPath, [WORKER_ENTRY], {
      env: {
        ...process.env,
        WORKER_HTTP_PORT: String(await freePort()),
        WORKER_CONCURRENCY: '1',
      },
      stdio: 'ignore',
    });
    await waitFor(
      'the child worker to reach the second step',
      () => receiver.hits('/ship').length === 1,
      { timeoutMs: 20_000 },
    );

    const exited = new Promise<NodeJS.Signals | null>((resolve) =>
      child!.once('exit', (_code, signal) => resolve(signal)),
    );
    child.kill('SIGKILL');
    expect(await exited).toBe('SIGKILL');
    child = undefined;
    hold = false;

    rescuer = await startWorker(1);
    await waitFor(
      'the execution to be finished by the other worker',
      async () =>
        (await ds.getRepository(Execution).findOneByOrFail({ id })).status ===
        'succeeded',
      { timeoutMs: 20_000 },
    );

    expect(receiver.hits('/charge')).toHaveLength(1);
    const ship = receiver.hits('/ship');
    expect(ship).toHaveLength(2);
    expect(ship[1].headers['idempotency-key']).toBe(
      ship[0].headers['idempotency-key'],
    );
    expect(shipped.size).toBe(1);
    const steps = await ds
      .getRepository(StepRun)
      .find({ where: { executionId: id }, order: { stepIndex: 'ASC' } });
    expect(steps.map((s) => [s.stepId, s.status, s.attempts])).toEqual([
      ['charge', 'succeeded', 1],
      ['ship', 'succeeded', 2],
      ['done', 'succeeded', 1],
    ]);
  });
});
