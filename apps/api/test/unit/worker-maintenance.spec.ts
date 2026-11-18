import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import {
  EnvironmentVariables,
  MAX_TIMER_MS,
} from '../../src/config/env.validation';
import { CheckpointService } from '../../src/engine/checkpoint.service';
import { JobQueueService } from '../../src/engine/job-queue.service';
import { JobRunnerService } from '../../src/engine/job-runner.service';
import { QueueMetrics } from '../../src/engine/queue.metrics';
import { StepExecutor } from '../../src/engine/step-executor';
import { Execution, WorkflowVersion } from '../../src/entities';

describe('worker maintenance', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function start(
    reapExpired: jest.Mock,
    purgeFinished = jest.fn().mockResolvedValue(0),
  ) {
    const values: Partial<EnvironmentVariables> = {
      JOB_LEASE_MS: 1000,
      JOB_CLEANUP_INTERVAL_MS: MAX_TIMER_MS,
      JOB_RETENTION_DAYS: 7,
    };
    const runner = new JobRunnerService(
      { reapExpired, purgeFinished } as unknown as JobQueueService,
      {} as StepExecutor,
      {} as Repository<Execution>,
      {} as Repository<WorkflowVersion>,
      {} as CheckpointService,
      {
        get: (key: keyof EnvironmentVariables) => values[key],
      } as unknown as ConfigService<EnvironmentVariables, true>,
      { jobsPurged: { inc: jest.fn() } } as unknown as QueueMetrics,
    );
    runner.start(0);
    return runner;
  }

  it('runs one reaper pass at a time and drains the active pass before shutdown', async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const reap = jest.fn(async () => {
      await pending;
      return [];
    });
    const runner = start(reap);
    await jest.advanceTimersByTimeAsync(3000);
    let stopped = false;
    const closing = runner.beforeApplicationShutdown().then(() => {
      stopped = true;
    });
    await jest.advanceTimersByTimeAsync(1);
    const stoppedEarly = stopped;
    finish();
    await closing;
    expect(reap).toHaveBeenCalledTimes(1);
    expect(stoppedEarly).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('caps the jittered cleanup timeout at the Node timer maximum', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.99);
    const timeout = jest.spyOn(global, 'setTimeout');
    const runner = start(jest.fn().mockResolvedValue([]));
    await runner.beforeApplicationShutdown();
    expect(timeout.mock.calls.map((call) => call[1])).toContain(MAX_TIMER_MS);
  });
});
