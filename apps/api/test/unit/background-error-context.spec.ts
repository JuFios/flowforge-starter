import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvironmentVariables } from '../../src/config/env.validation';
import { CheckpointService } from '../../src/engine/checkpoint.service';
import {
  ClaimedJob,
  JobQueueService,
} from '../../src/engine/job-queue.service';
import { JobRunnerService } from '../../src/engine/job-runner.service';
import { QueueMetrics } from '../../src/engine/queue.metrics';
import { StepExecutor } from '../../src/engine/step-executor';
import { ExecutionsService } from '../../src/executions/executions.service';
import { getCorrelationId } from '../../src/observability/correlation';
import { MetricsService } from '../../src/observability/metrics.service';
import { SchedulerMetrics } from '../../src/scheduler/scheduler.metrics';
import { SchedulerService } from '../../src/scheduler/scheduler.service';
import { SystemDb } from '../../src/tenancy/system-db';
import { fakeTenantDb } from '../helpers/fake-tenant-db';

interface LogRecord {
  fields: { [key: string]: unknown };
  message: unknown;
  /** ID, який потрапить у рядок логу: явне поле або контекст AsyncLocalStorage (mixin pino). */
  correlationId: unknown;
}

function config(
  values: Partial<EnvironmentVariables>,
): ConfigService<EnvironmentVariables, true> {
  return {
    get: (key: keyof EnvironmentVariables) => values[key],
  } as unknown as ConfigService<EnvironmentVariables, true>;
}

/**
 * Помилка обробки задачі чи спрацювання cron має логуватися з тим самим кореляційним ID,
 * що й решта логів цієї задачі, і з ідентифікаторами, за якими її можна знайти.
 */
describe('background error logs keep the correlation context', () => {
  let errors: LogRecord[];

  beforeEach(() => {
    errors = [];
    const capture = (fields: unknown, message?: unknown) => {
      const f = (fields ?? {}) as { [key: string]: unknown };
      errors.push({
        fields: f,
        message,
        correlationId: f.correlationId ?? getCorrelationId(),
      });
    };
    jest.spyOn(Logger.prototype, 'error').mockImplementation(capture);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(capture);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('worker: a job that fails while being processed', async () => {
    const db = fakeTenantDb({
      findOneOrFail: () => Promise.reject(new Error('Execution not found')),
    });
    const runner = new JobRunnerService(
      {} as JobQueueService,
      {} as StepExecutor,
      db,
      {} as CheckpointService,
      config({ WORKER_CONCURRENCY: 1, JOB_LEASE_MS: 60000 }),
      {} as QueueMetrics,
    );
    const job = {
      id: 'job-1',
      executionId: 'exec-1',
      correlationId: 'origin-req-9',
      attempts: 1,
      leaseStartedAt: performance.now(),
    } as ClaimedJob;

    await runner.process(job).catch(() => undefined);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      correlationId: 'origin-req-9',
      fields: { jobId: 'job-1', executionId: 'exec-1' },
    });
  });

  it('scheduler: a scheduled run that cannot be created', async () => {
    const seen: Array<string | undefined> = [];
    const wf = { id: 'wf-1', tenantId: 't-1', cron: '* * * * * *' };
    const system = {
      dueScheduleTenants: (after: string | null) =>
        Promise.resolve(after ? [] : [{ tenantId: wf.tenantId }]),
    } as unknown as SystemDb;
    const db = fakeTenantDb({
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
    } as never);
    const executions = {
      enqueueScheduledIn: () => {
        seen.push(getCorrelationId());
        // Помилка БД саме цього спрацювання (SQLSTATE), а не втрачене з'єднання.
        return Promise.reject(
          Object.assign(new Error('deadlock detected'), { code: '40P01' }),
        );
      },
    } as unknown as ExecutionsService;
    const scheduler = new SchedulerService(
      system,
      db,
      executions,
      config({ SCHEDULER_TICK_MS: 1000, SCHEDULER_MISFIRE_GRACE_MS: 60_000 }),
      new SchedulerMetrics(new MetricsService()),
    );

    await scheduler.tick();

    expect(errors).toHaveLength(1);
    expect(seen[0]).toMatch(/^cron:wf-1:\d+$/);
    expect(errors[0]).toMatchObject({
      correlationId: seen[0],
      fields: {
        workflowId: 'wf-1',
        scheduledAt: expect.any(String) as unknown,
      },
    });
  });
});
