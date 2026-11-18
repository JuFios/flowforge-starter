import { DataSource } from 'typeorm';
import { AppModule, WorkerModule } from '../../src/app.module';
import { JobQueueService } from '../../src/engine/job-queue.service';
import { StepExecutor } from '../../src/engine/step-executor';
import { JobRunnerService } from '../../src/engine/job-runner.service';
import { Execution, StepRun } from '../../src/entities';
import { RunningApp, startApp } from '../helpers/app';
import { createTenant, openTestDataSource, truncateAll } from '../helpers/db';
import { api, waitFor } from '../helpers/queue';

const WORKERS = 3;
const JOBS = 40;

describe('job queue with several workers', () => {
  let ds: DataSource;
  let apiApp: RunningApp;
  let workers: RunningApp[] = [];

  beforeAll(async () => {
    ds = await openTestDataSource();
    apiApp = await startApp(AppModule);
  });

  beforeEach(() => truncateAll(ds));

  afterEach(async () => {
    await Promise.all(workers.map((w) => w.close()));
    workers = [];
  });

  afterAll(async () => {
    await apiApp.close();
    await ds.destroy();
  });

  async function enqueue(count: number): Promise<string[]> {
    const { apiKey } = await createTenant(ds);
    const wf = await api<{ id: string }>(
      apiApp.baseUrl,
      apiKey,
      'POST',
      '/workflows',
      {
        name: 'claim',
        steps: [{ id: 'say', type: 'log', message: 'n={{ input.n }}' }],
      },
    );
    const ids: string[] = [];
    for (let n = 0; n < count; n++) {
      const run = await api<{ id: string }>(
        apiApp.baseUrl,
        apiKey,
        'POST',
        `/workflows/${wf.body.id}/run`,
        { n },
      );
      ids.push(run.body.id);
    }
    return ids;
  }

  it('hands every queued job to exactly one of several concurrently polling workers', async () => {
    await enqueue(JOBS);
    // Кожен «воркер» — окремий застосунок зі своїм пулом з'єднань; циклів обробки не запускаємо,
    // лише змагаємося за захоплення.
    for (let i = 0; i < WORKERS; i++)
      workers.push(await startApp(WorkerModule));
    const claimed: string[] = [];
    await Promise.all(
      workers.flatMap((w, wi) =>
        [0, 1, 2, 3].map(async (slot) => {
          const queue = w.app.get(JobQueueService);
          for (;;) {
            const job = await queue.claimNext(`claimer-${wi}-${slot}`);
            if (!job) return;
            claimed.push(job.id);
          }
        }),
      ),
    );

    expect(claimed).toHaveLength(JOBS);
    expect(new Set(claimed).size).toBe(JOBS);
  });

  it('runs each step of each execution exactly once with several workers', async () => {
    const ids = await enqueue(JOBS);
    const calls = [];
    for (let i = 0; i < WORKERS; i++) {
      const worker = await startApp(WorkerModule);
      workers.push(worker);
      calls.push(jest.spyOn(worker.app.get(StepExecutor), 'execute'));
      worker.app.get(JobRunnerService).start(4);
    }

    await waitFor('all executions to finish', async () => {
      const done = await ds
        .getRepository(Execution)
        .countBy(ids.map((id) => ({ id, status: 'succeeded' as const })));
      return done === JOBS;
    });
    // Дочекатися, поки воркери закінчать і можливі дубльовані обробки.
    await Promise.all(workers.map((w) => w.close()));
    workers = [];

    const runs = await ds
      .getRepository(StepRun)
      .findBy(ids.map((executionId) => ({ executionId })));
    expect(runs.map((run) => run.executionId).sort()).toEqual(ids.sort());
    const invoked = calls.flatMap((spy) =>
      spy.mock.calls.map(([, , options]) => options?.idempotencyKey),
    );
    expect(invoked.sort()).toEqual(
      runs.map((run) => run.idempotencyKey).sort(),
    );
  });
});
