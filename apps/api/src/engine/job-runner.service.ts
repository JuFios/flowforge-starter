import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { EnvironmentVariables } from '../config/env.validation';
import { Execution, Job, WorkflowVersion } from '../entities';
import {
  newCorrelationId,
  runWithCorrelationId,
} from '../observability/correlation';
import { toSafeError } from '../observability/safe-error';
import { CheckpointService } from './checkpoint.service';
import { JobQueueService, LeaseLostError } from './job-queue.service';
import { LeaseKeeper } from './lease-keeper';
import { StepError, StepExecutor } from './step-executor';
import { StepContext } from './template';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

@Injectable()
export class JobRunnerService implements OnApplicationShutdown {
  private readonly logger = new Logger(JobRunnerService.name);
  readonly workerId = `worker-${randomUUID().slice(0, 8)}`;
  private running = false;
  private reaper?: NodeJS.Timeout;

  constructor(
    private readonly queue: JobQueueService,
    private readonly executor: StepExecutor,
    @InjectRepository(Execution)
    private readonly executions: Repository<Execution>,
    @InjectRepository(WorkflowVersion)
    private readonly versions: Repository<WorkflowVersion>,
    private readonly checkpoints: CheckpointService,
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {}

  start(
    concurrency = this.config.get('WORKER_CONCURRENCY', { infer: true }),
  ): void {
    this.running = true;
    this.logger.log(`${this.workerId} started, concurrency=${concurrency}`);
    for (let i = 0; i < concurrency; i++) void this.loop();
    const leaseMs = this.config.get('JOB_LEASE_MS', { infer: true });
    this.reaper = setInterval(() => void this.reap(), leaseMs / 2);
  }

  onApplicationShutdown(): void {
    this.running = false;
    clearInterval(this.reaper);
  }

  /** Пауза опитування з відхиленням ±50%: воркери не стукають у БД синхронно. */
  private idle(): Promise<void> {
    const base = this.config.get('WORKER_POLL_INTERVAL_MS', { infer: true });
    return sleep(base * (0.5 + Math.random()));
  }

  /** Повертає в чергу задачі зниклих воркерів. Помилка не зупиняє воркер — наступний прохід повторить. */
  private async reap(): Promise<void> {
    try {
      for (const job of await this.queue.reapExpired()) {
        await runWithCorrelationId(
          job.correlationId ?? newCorrelationId(),
          'job',
          () => {
            this.logger.warn(
              {
                jobId: job.id,
                executionId: job.executionId,
                attempt: job.attempts,
                outcome: job.status,
              },
              job.status === 'queued'
                ? 'lease expired, job returned to the queue'
                : 'lease expired, no attempts left',
            );
            return Promise.resolve();
          },
        );
      }
    } catch (err) {
      this.logger.error({ error: toSafeError(err) }, 'lease reaper failed');
    }
  }

  private async loop(): Promise<void> {
    while (this.running) {
      let job: Job | null;
      try {
        job = await this.queue.claimNext(this.workerId);
      } catch (err) {
        // Задачі ще немає, тож і кореляційного контексту теж.
        this.logger.error({ error: toSafeError(err) }, 'job claim failed');
        await sleep(1000);
        continue;
      }
      if (!job) {
        await this.idle();
        continue;
      }
      try {
        await this.process(job);
      } catch {
        // Уже залоговано в process() — у контексті задачі; лише пауза перед наступною.
        await sleep(1000);
      }
    }
  }

  /**
   * Обробляє задачу в кореляційному контексті запиту/спрацювання, що її створило.
   * Непередбачена помилка логується тут же, всередині контексту (той самий correlationId,
   * jobId, executionId), і передається далі.
   */
  process(job: Job): Promise<void> {
    return runWithCorrelationId(
      job.correlationId ?? newCorrelationId(),
      'job',
      async () => {
        const keeper = new LeaseKeeper(
          this.queue,
          job,
          this.config.get('JOB_LEASE_MS', { infer: true }),
        ).start();
        try {
          await this.processInContext(job, keeper.signal);
        } catch (err) {
          if (err instanceof LeaseLostError || keeper.signal.aborted) {
            // Задачу вже повернуто в чергу або вона в іншого воркера — тут нічого не записуємо.
            this.logger.warn(
              { jobId: job.id, executionId: job.executionId },
              'job abandoned: lease is no longer held',
            );
            return;
          }
          this.logger.error(
            {
              jobId: job.id,
              executionId: job.executionId,
              error: toSafeError(err),
            },
            'job processing failed',
          );
          throw err;
        } finally {
          keeper.stop();
        }
      },
    );
  }

  private async processInContext(job: Job, signal: AbortSignal): Promise<void> {
    this.logger.log(
      { jobId: job.id, executionId: job.executionId, attempt: job.attempts },
      'processing job',
    );
    const execution = await this.executions.findOneOrFail({
      where: { id: job.executionId },
    });
    // Знімок версії, зафіксований під час створення виконання, а не поточний стан workflow.
    const snapshot = await this.versions.findOneOrFail({
      where: { id: execution.workflowVersionId ?? undefined },
    });

    const ctx: StepContext = { input: execution.input, steps: {} };
    const done = new Map(
      (await this.checkpoints.load(execution.id))
        .filter((r) => r.status === 'succeeded')
        .map((r) => [r.stepIndex, r]),
    );

    try {
      for (let i = 0; i < snapshot.steps.length; i++) {
        const step = snapshot.steps[i];
        const checkpoint = done.get(i);
        if (checkpoint) {
          // Крок уже завершено в попередній спробі: беремо збережений результат, не виконуємо знову.
          ctx.steps[step.id] = checkpoint.output;
          continue;
        }
        signal.throwIfAborted();
        const run = await this.checkpoints.startStep(job, i, step.id);
        let output: unknown;
        try {
          output = await this.executor.execute(step, ctx, signal);
        } catch (err) {
          if (!signal.aborted)
            await this.checkpoints.stepFailed(job, run, (err as Error).message);
          throw err;
        }
        await this.checkpoints.checkpoint(job, run, output);
        ctx.steps[step.id] = output;
      }
      const last = snapshot.steps[snapshot.steps.length - 1];
      await this.executions.update(execution.id, {
        status: 'succeeded',
        output: ctx.steps[last.id] as object,
        finishedAt: new Date(),
      });
      await this.queue.complete(job);
    } catch (err) {
      if (err instanceof LeaseLostError || signal.aborted) throw err;
      const retryable = err instanceof StepError ? err.retryable : true;
      const willRetry = await this.queue.fail(
        job,
        (err as Error).message,
        retryable,
      );
      if (!willRetry) {
        await this.executions.update(execution.id, {
          status: 'failed',
          error: (err as Error).message,
          finishedAt: new Date(),
        });
      }
    }
  }
}
