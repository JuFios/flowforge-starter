import { DataSource } from 'typeorm';
import { WorkerModule } from '../../src/app.module';
import { JobQueueService } from '../../src/engine/job-queue.service';
import { JobRunnerService } from '../../src/engine/job-runner.service';
import { StepExecutor } from '../../src/engine/step-executor';
import { Execution, Job } from '../../src/entities';
import { getCorrelationId } from '../../src/observability/correlation';
import { RunningApp, startApp } from '../helpers/app';
import {
  createExecution,
  createTenant,
  createWorkflow,
  openTestDataSource,
  truncateAll,
} from '../helpers/db';

describe('worker carries the correlation id of the originating request', () => {
  let ds: DataSource;
  let worker: RunningApp;

  beforeAll(async () => {
    ds = await openTestDataSource();
    worker = await startApp(WorkerModule);
  });

  beforeEach(() => truncateAll(ds));

  afterAll(async () => {
    await worker.close();
    await ds.destroy();
  });

  it('runs steps inside the job correlation context', async () => {
    const { tenant } = await createTenant(ds);
    const wf = await createWorkflow(ds, tenant.id);
    // Так, як їх створює API (ланцюжок запит → execution/job перевірено в observability.int-spec).
    const execution = await createExecution(ds, wf, {
      input: { name: 'Ada' },
      correlationId: 'origin-req-7',
    });
    await ds.getRepository(Job).save({
      tenantId: tenant.id,
      executionId: execution.id,
      correlationId: 'origin-req-7',
    });
    // Обробляти можна лише захоплену задачу (з lease і fencing-токеном), як у циклі воркера.
    const job = (await worker.app
      .get(JobQueueService)
      .claimNext(worker.app.get(JobRunnerService).workerId))!;
    expect(job.executionId).toBe(execution.id);

    const seen: Array<string | undefined> = [];
    const executor = worker.app.get(StepExecutor);
    const original = executor.execute.bind(executor);
    jest.spyOn(executor, 'execute').mockImplementation((step, ctx) => {
      seen.push(getCorrelationId());
      return original(step, ctx);
    });

    await worker.app.get(JobRunnerService).process(job);

    expect(seen).toEqual(['origin-req-7']);
    expect(
      (await ds.getRepository(Execution).findOneByOrFail({ id: execution.id }))
        .status,
    ).toBe('succeeded');
  });

  it('exposes /health, /ready and /metrics on the worker service port', async () => {
    for (const path of ['/health', '/ready', '/metrics']) {
      const res = await fetch(`${worker.baseUrl}${path}`);
      expect(res.status).toBe(200);
    }
  });
});
