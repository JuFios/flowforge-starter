import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { EnvironmentVariables } from '../../src/config/env.validation';
import { CheckpointService } from '../../src/engine/checkpoint.service';
import { JobQueueService } from '../../src/engine/job-queue.service';
import { JobRunnerService } from '../../src/engine/job-runner.service';
import { QueueMetrics } from '../../src/engine/queue.metrics';
import { StepExecutor } from '../../src/engine/step-executor';
import { Execution, Job, WorkflowVersion } from '../../src/entities';

/**
 * Воркер виконує лише знімок версії, зафіксований у виконанні. Пошук `{ id: undefined }` TypeORM
 * виконує без умови й повертає першу-ліпшу версію — тож без знімку виконання не можна запускати.
 */
describe('worker without a workflow version snapshot', () => {
  beforeEach(() => {
    for (const level of ['log', 'warn', 'error'] as const)
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('fails the execution for good instead of running some other version', async () => {
    const anyVersion = jest.fn().mockResolvedValue({
      id: 'v-other',
      steps: [{ id: 'say', type: 'log', message: 'wrong workflow' }],
    });
    const fail = jest.fn().mockResolvedValue('failed');
    const config = {
      get: (key: keyof EnvironmentVariables) =>
        ({ JOB_LEASE_MS: 60_000 })[key as string],
    } as unknown as ConfigService<EnvironmentVariables, true>;
    const runner = new JobRunnerService(
      {
        heartbeat: jest.fn().mockResolvedValue(true),
      } as unknown as JobQueueService,
      { execute: jest.fn() } as unknown as StepExecutor,
      {
        findOneOrFail: jest.fn().mockResolvedValue({
          id: 'e-1',
          input: {},
          workflowVersionId: null,
        }),
      } as unknown as Repository<Execution>,
      {
        findOneOrFail: anyVersion,
        findOneByOrFail: anyVersion,
      } as unknown as Repository<WorkflowVersion>,
      {
        load: jest.fn().mockResolvedValue([]),
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
    } as Job);

    expect(anyVersion).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'j-1' }),
      undefined,
      'execution has no workflow version snapshot',
      false,
      undefined,
    );
  });
});
