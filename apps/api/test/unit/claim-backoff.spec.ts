import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QueryFailedError } from 'typeorm';
import { EnvironmentVariables } from '../../src/config/env.validation';
import { CheckpointService } from '../../src/engine/checkpoint.service';
import { JobQueueService } from '../../src/engine/job-queue.service';
import { JobRunnerService } from '../../src/engine/job-runner.service';
import { QueueMetrics } from '../../src/engine/queue.metrics';
import { StepExecutor } from '../../src/engine/step-executor';
import { fakeTenantDb } from '../helpers/fake-tenant-db';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * Коли БД недоступна, захоплення падає в кожному циклі воркера. Воркер має відступати
 * експоненційно й спільно для всіх циклів, а не стукати в БД і писати в лог щосекунди з кожного.
 */
describe('worker backs off when claiming jobs fails', () => {
  const CONCURRENCY = 16;
  let errorLog: jest.SpiedFunction<Logger['error']>;
  let infoLog: jest.SpiedFunction<Logger['log']>;
  let runner: JobRunnerService | undefined;
  let releaseClaims: (() => void) | undefined;

  beforeEach(() => {
    errorLog = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    infoLog = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
  });

  afterEach(async () => {
    const shutdown = runner?.beforeApplicationShutdown();
    releaseClaims?.();
    await shutdown;
    runner = undefined;
    releaseClaims = undefined;
    jest.restoreAllMocks();
  });

  const metrics = {
    observeClaim: jest.fn(),
    claimFailures: { inc: jest.fn() },
    jobsPurged: { inc: jest.fn() },
  };

  function startRunner(claimNext: jest.Mock): void {
    metrics.claimFailures.inc.mockClear();
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
      fakeTenantDb(),
      {} as CheckpointService,
      {
        get: (key: keyof EnvironmentVariables) => values[key],
      } as unknown as ConfigService<EnvironmentVariables, true>,
      metrics as unknown as QueueMetrics,
    );
    runner.start(CONCURRENCY);
  }

  /** Збій, як у справжньої спроби з'єднання з недоступною БД: не миттєвий. */
  const outage = () =>
    sleep(100).then(() =>
      Promise.reject(
        new QueryFailedError(
          'UPDATE jobs',
          [],
          new Error('connection refused'),
        ),
      ),
    );

  it('probes the database with one loop at a growing interval and logs once per probe', async () => {
    const secondProbe = signal();
    const started: number[] = [];
    jest.spyOn(Math, 'random').mockReturnValue(0.25);
    const claimNext = jest.fn(() => {
      started.push(Date.now());
      if (started.length === CONCURRENCY + 2) secondProbe.resolve();
      return outage();
    });
    startRunner(claimNext);
    await secondProbe.promise;

    // Остання перевірка вже почалася, але БД ще не відповіла.
    expect(metrics.claimFailures.inc).toHaveBeenCalledTimes(CONCURRENCY + 1);
    await runner?.beforeApplicationShutdown();
    expect(claimNext).toHaveBeenCalledTimes(CONCURRENCY + 2);
    expect(metrics.claimFailures.inc).toHaveBeenCalledTimes(CONCURRENCY + 2);
    const failureLogs = errorLog.mock.calls.filter(
      ([, text]) => text === 'job claim failed',
    );
    expect(failureLogs).toMatchObject(
      [1250, 1750, 2750].map((retryInMs) => [
        { retryInMs },
        'job claim failed',
      ]),
    );
    // За фіксованого jitter 0,25 — відступ 1250 мс після першого залпу та 1750 мс після першої перевірки.
    expect(started[CONCURRENCY] - started[0]).toBeGreaterThanOrEqual(1250);
    expect(
      started[CONCURRENCY + 1] - started[CONCURRENCY],
    ).toBeGreaterThanOrEqual(1750);
  }, 15_000);

  it('resumes claiming in every loop once the database is back', async () => {
    const allPolling = signal();
    const response = signal();
    releaseClaims = response.resolve;
    let started = 0;
    const claimNext = jest.fn(async () => {
      started++;
      if (started <= CONCURRENCY) return outage();
      if (started === CONCURRENCY + 1) return null;
      // Утримуємо по одному запиту від кожного циклу після успішної перевірки БД.
      if (started === 2 * CONCURRENCY + 1) allPolling.resolve();
      await response.promise;
      return null;
    });
    startRunner(claimNext);
    await allPolling.promise;

    const recovered = infoLog.mock.calls.filter(
      ([, text]) => text === 'job claim recovered',
    );
    expect(recovered).toHaveLength(1);
    expect(metrics.claimFailures.inc).toHaveBeenCalledTimes(CONCURRENCY);
    expect(claimNext).toHaveBeenCalledTimes(2 * CONCURRENCY + 1);
  }, 15_000);
});
