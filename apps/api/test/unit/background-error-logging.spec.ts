import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QueryFailedError, Repository } from 'typeorm';
import { EnvironmentVariables } from '../../src/config/env.validation';
import { CheckpointService } from '../../src/engine/checkpoint.service';
import { JobQueueService } from '../../src/engine/job-queue.service';
import { JobRunnerService } from '../../src/engine/job-runner.service';
import { QueueMetrics } from '../../src/engine/queue.metrics';
import { StepExecutor } from '../../src/engine/step-executor';
import { Execution, Workflow, WorkflowVersion } from '../../src/entities';
import { ExecutionsService } from '../../src/executions/executions.service';
import { SchedulerService } from '../../src/scheduler/scheduler.service';

const SECRET = 'tenant-secret-value';

/** Помилка БД, у тексті якої Postgres повторює вхідне значення. */
function dbError(): QueryFailedError {
  return new QueryFailedError(
    'SELECT 1',
    [SECRET],
    new Error(`invalid input syntax for type uuid: "${SECRET}"`),
  );
}

function config(
  values: Partial<EnvironmentVariables>,
): ConfigService<EnvironmentVariables, true> {
  return {
    get: (key: keyof EnvironmentVariables) => values[key],
  } as unknown as ConfigService<EnvironmentVariables, true>;
}

/** Помилки фонових циклів (планувальник, воркер) мають іти в лог через toSafeError, як і в HTTP. */
describe('background loops log errors without input values', () => {
  let logged: string[];

  beforeEach(() => {
    logged = [];
    const capture = (...args: unknown[]) => {
      logged.push(JSON.stringify(args));
    };
    jest.spyOn(Logger.prototype, 'error').mockImplementation(capture);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(capture);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('scheduler: a failing tick', async () => {
    jest.useFakeTimers();
    const workflows = {
      createQueryBuilder: () => {
        throw dbError();
      },
    } as unknown as Repository<Workflow>;
    const scheduler = new SchedulerService(
      workflows,
      {} as ExecutionsService,
      config({ SCHEDULER_TICK_MS: 1000 }),
    );

    scheduler.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(1000);
    scheduler.onApplicationShutdown();

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('QueryFailedError');
    expect(logged[0]).not.toContain(SECRET);
  });

  it('scheduler: a failing enqueue for one workflow', async () => {
    const wf = { id: 'wf-1', cron: '* * * * * *' } as Workflow;
    const workflows = {
      createQueryBuilder: () => ({
        where: () => ({ getMany: () => Promise.resolve([wf]) }),
      }),
    } as unknown as Repository<Workflow>;
    const executions = {
      enqueue: () => Promise.reject(dbError()),
    } as unknown as ExecutionsService;
    const scheduler = new SchedulerService(
      workflows,
      executions,
      config({ SCHEDULER_TICK_MS: 1000 }),
    );

    await scheduler.tick(new Date(Date.now() + 5000));

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('QueryFailedError');
    expect(logged[0]).not.toContain(SECRET);
  });

  it('worker: a failing claim in the processing loop', async () => {
    const queue = {
      claimNext: jest.fn().mockRejectedValue(dbError()),
      reapExpired: jest.fn().mockResolvedValue([]),
    } as unknown as JobQueueService;
    const runner = new JobRunnerService(
      queue,
      {} as StepExecutor,
      {} as Repository<Execution>,
      {} as Repository<WorkflowVersion>,
      {} as CheckpointService,
      config({
        WORKER_CONCURRENCY: 1,
        JOB_LEASE_MS: 60_000,
        JOB_CLEANUP_INTERVAL_MS: 600_000,
      }),
      {} as QueueMetrics,
    );

    runner.start(1);
    for (let i = 0; i < 50 && logged.length === 0; i++)
      await new Promise((r) => setTimeout(r, 10));
    await runner.beforeApplicationShutdown();
    // дати циклу вийти з паузи після помилки, щоб не лишати таймер
    await new Promise((r) => setTimeout(r, 1100));

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('QueryFailedError');
    expect(logged[0]).not.toContain(SECRET);
  });
});
