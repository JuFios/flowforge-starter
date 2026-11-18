import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QueryFailedError, Repository } from 'typeorm';
import { EnvironmentVariables } from '../../src/config/env.validation';
import { CheckpointService } from '../../src/engine/checkpoint.service';
import { JobQueueService } from '../../src/engine/job-queue.service';
import { JobRunnerService } from '../../src/engine/job-runner.service';
import { QueueMetrics } from '../../src/engine/queue.metrics';
import { StepExecutor } from '../../src/engine/step-executor';
import { Execution, WorkflowVersion } from '../../src/entities';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Коли БД недоступна, захоплення падає в кожному циклі воркера. Воркер має відступати
 * експоненційно й спільно для всіх циклів, а не стукати в БД і писати в лог щосекунди з кожного.
 */
describe('worker backs off when claiming jobs fails', () => {
  const CONCURRENCY = 16;
  let errors: string[];
  let infos: string[];
  let runner: JobRunnerService | undefined;

  beforeEach(() => {
    errors = [];
    infos = [];
    const capture = (into: string[]) => (message: unknown, text?: unknown) => {
      into.push(String(text ?? message));
    };
    jest.spyOn(Logger.prototype, 'error').mockImplementation(capture(errors));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(capture(errors));
    jest.spyOn(Logger.prototype, 'log').mockImplementation(capture(infos));
  });

  afterEach(async () => {
    await runner?.beforeApplicationShutdown();
    runner = undefined;
    jest.restoreAllMocks();
  });

  function startRunner(claimNext: jest.Mock): void {
    const values: Partial<EnvironmentVariables> = {
      WORKER_CONCURRENCY: CONCURRENCY,
      JOB_LEASE_MS: 600_000,
      JOB_CLEANUP_INTERVAL_MS: 600_000,
      WORKER_POLL_INTERVAL_MS: 10,
      WORKER_SHUTDOWN_GRACE_MS: 0,
    };
    runner = new JobRunnerService(
      {
        claimNext,
        reapExpired: jest.fn().mockResolvedValue([]),
      } as unknown as JobQueueService,
      {} as StepExecutor,
      {} as Repository<Execution>,
      {} as Repository<WorkflowVersion>,
      {} as CheckpointService,
      {
        get: (key: keyof EnvironmentVariables) => values[key],
      } as unknown as ConfigService<EnvironmentVariables, true>,
      { observeClaim: jest.fn() } as unknown as QueueMetrics,
    );
    runner.start(CONCURRENCY);
  }

  const outage = () =>
    new QueryFailedError('UPDATE jobs', [], new Error('connection refused'));

  it('probes the database with one loop at a growing interval and logs once per probe', async () => {
    const claimNext = jest.fn().mockRejectedValue(outage());
    startRunner(claimNext);
    await sleep(3_500);

    const failures = errors.filter((e) => e === 'job claim failed');
    // Без backoff: кожен із 16 циклів щосекунди — ~56 спроб і ~56 рядків логу за 3,5 с.
    // З backoff (1 с, потім до 2 с, …): перший залп усіх циклів і не більше 3 перевірок.
    expect(claimNext.mock.calls.length).toBeLessThanOrEqual(CONCURRENCY + 3);
    expect(failures.length).toBeGreaterThanOrEqual(1);
    expect(failures.length).toBeLessThanOrEqual(3);
  });

  it('resumes claiming in every loop once the database is back', async () => {
    let down = true;
    const claimNext = jest.fn(() =>
      down ? Promise.reject(outage()) : Promise.resolve(null),
    );
    startRunner(claimNext);
    await sleep(500);
    down = false;
    const before = claimNext.mock.calls.length;
    // Наступна перевірка — щонайпізніше через 2 с (перший інтервал backoff).
    await sleep(2_500);

    expect(infos).toContain('job claim recovered');
    // Опитування порожньої черги кожні ~10 мс у кожному з 16 циклів.
    expect(claimNext.mock.calls.length - before).toBeGreaterThan(100);
  });
});
