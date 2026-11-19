import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QueryFailedError } from 'typeorm';
import { EnvironmentVariables } from '../../src/config/env.validation';
import { CheckpointService } from '../../src/engine/checkpoint.service';
import { JobQueueService } from '../../src/engine/job-queue.service';
import { JobRunnerService } from '../../src/engine/job-runner.service';
import { QueueMetrics } from '../../src/engine/queue.metrics';
import { StepExecutor } from '../../src/engine/step-executor';
import { Workflow } from '../../src/entities';
import { ExecutionsService } from '../../src/executions/executions.service';
import { MetricsService } from '../../src/observability/metrics.service';
import { SchedulerMetrics } from '../../src/scheduler/scheduler.metrics';
import { SchedulerService } from '../../src/scheduler/scheduler.service';
import { SystemDb } from '../../src/tenancy/system-db';
import { fakeTenantDb } from '../helpers/fake-tenant-db';

const SECRET = 'tenant-secret-value';

/** Помилка БД, у тексті якої Postgres повторює вхідне значення. */
function dbError(): QueryFailedError {
  return new QueryFailedError(
    'SELECT 1',
    [SECRET],
    Object.assign(
      new Error(`invalid input syntax for type uuid: "${SECRET}"`),
      { code: '22P02' },
    ),
  );
}

/** EntityManager планувальника: сторінка з одним workflow і його рядок під блокуванням. */
function schedulerEm(wf: Partial<Workflow>) {
  return {
    create: (_type: unknown, fields: unknown) => fields,
    query: (sql: string) =>
      Promise.resolve(
        sql.includes('FOR NO KEY UPDATE')
          ? [
              {
                ...wf,
                timezone: 'UTC',
                version: 1,
                missedRunPolicy: 'run_all',
                scheduleCursor: new Date(Date.now() - 5_000),
                nextFireAt: new Date(0),
                scheduleBlockedSince: null,
                scheduleError: null,
                now: new Date(),
              },
            ]
          : sql.startsWith('SELECT id FROM workflows')
            ? [{ id: wf.id }]
            : [],
      ),
  } as never;
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
    const system = {
      dueScheduleTenants: () => Promise.reject(dbError()),
    } as unknown as SystemDb;
    const scheduler = new SchedulerService(
      system,
      fakeTenantDb(),
      {} as ExecutionsService,
      config({ SCHEDULER_TICK_MS: 1000 }),
      new SchedulerMetrics(new MetricsService()),
    );

    scheduler.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(1000);
    scheduler.onApplicationShutdown();

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('QueryFailedError');
    expect(logged[0]).not.toContain(SECRET);
  });

  it('scheduler: a failing enqueue for one workflow', async () => {
    const wf = {
      id: 'wf-1',
      tenantId: 't-1',
      cron: '* * * * * *',
    } as Workflow;
    const system = {
      dueScheduleTenants: (after: string | null) =>
        Promise.resolve(after ? [] : [{ tenantId: wf.tenantId }]),
    } as unknown as SystemDb;
    const executions = {
      enqueueScheduledIn: () => Promise.reject(dbError()),
    } as unknown as ExecutionsService;
    const scheduler = new SchedulerService(
      system,
      fakeTenantDb(schedulerEm(wf)),
      executions,
      config({ SCHEDULER_TICK_MS: 1000, SCHEDULER_MISFIRE_GRACE_MS: 60_000 }),
      new SchedulerMetrics(new MetricsService()),
    );

    await scheduler.tick();

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
      fakeTenantDb(),
      {} as CheckpointService,
      config({
        WORKER_CONCURRENCY: 1,
        JOB_LEASE_MS: 60_000,
        JOB_CLEANUP_INTERVAL_MS: 600_000,
      }),
      { claimFailures: { inc: jest.fn() } } as unknown as QueueMetrics,
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
