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
import { fakeTenantDb } from '../helpers/fake-tenant-db';

/**
 * Воркер виконує лише знімок версії, зафіксований у виконанні. Кроки він читає за
 * `executions."workflowVersionId"` (CheckpointService.resume); без знімку `steps` — null, і виконання
 * не можна запускати жодною іншою версією.
 */
describe('worker without a workflow version snapshot', () => {
  beforeEach(() => {
    for (const level of ['log', 'warn', 'error'] as const)
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('fails the execution for good instead of running some other version', async () => {
    const fail = jest.fn().mockResolvedValue('failed');
    const execute = jest.fn();
    const config = {
      get: (key: keyof EnvironmentVariables) =>
        ({ JOB_LEASE_MS: 60_000 })[key as string],
    } as unknown as ConfigService<EnvironmentVariables, true>;
    const runner = new JobRunnerService(
      {
        heartbeat: jest.fn().mockResolvedValue(true),
      } as unknown as JobQueueService,
      { execute } as unknown as StepExecutor,
      fakeTenantDb({}),
      {
        resume: jest
          .fn()
          .mockResolvedValue({ input: {}, steps: null, history: [] }),
        startStep: jest.fn().mockRejectedValue(new Error('must not start')),
        fail,
      } as unknown as CheckpointService,
      config,
      {
        observeFailure: jest.fn(),
        observeStep: jest.fn(),
      } as unknown as QueueMetrics,
    );

    await runner.process({
      id: 'j-1',
      executionId: 'e-1',
      lockToken: 't',
      attempts: 1,
      leaseStartedAt: performance.now(),
    } as ClaimedJob);

    expect(execute).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'j-1' }),
      undefined,
      'execution has no workflow version snapshot',
      false,
      undefined,
    );
  });
});
