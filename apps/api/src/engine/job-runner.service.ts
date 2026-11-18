import { BeforeApplicationShutdown, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Repository } from 'typeorm';
import { EnvironmentVariables } from '../config/env.validation';
import { Execution, Job, StepRun, WorkflowVersion } from '../entities';
import {
  newCorrelationId,
  runWithCorrelationId,
} from '../observability/correlation';
import { toSafeError } from '../observability/safe-error';
import { CheckpointService } from './checkpoint.service';
import {
  ClaimedJob,
  JobQueueService,
  LeaseLostError,
} from './job-queue.service';
import { LeaseKeeper } from './lease-keeper';
import { QueueMetrics } from './queue.metrics';
import { StepError, StepExecutor } from './step-executor';
import { StepContext } from './template';

/** Причина скасування кроку, коли воркер завершується і пільговий час вичерпано. */
class ShutdownAbort extends Error {
  constructor() {
    super('worker is shutting down');
  }
}

/** Повідомлення для тенанта про збій, що стався не в самому кроці. */
const INTERNAL_STEP_ERROR = 'internal error while running the step';

/** Скільки після скасування кроків чекаємо, поки задачі повернуться в чергу. */
const RELEASE_WAIT_MS = 5_000;

@Injectable()
export class JobRunnerService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(JobRunnerService.name);
  readonly workerId = `worker-${randomUUID().slice(0, 8)}`;
  /** Скасовується на початку завершення: цикли перестають брати задачі й виходять із пауз. */
  private stopping = new AbortController();
  private loops: Promise<void>[] = [];
  private readonly inFlight = new Map<
    string,
    { keeper: LeaseKeeper; done: Promise<void> }
  >();
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
    private readonly metrics: QueueMetrics,
  ) {}

  start(
    concurrency = this.config.get('WORKER_CONCURRENCY', { infer: true }),
  ): void {
    this.stopping = new AbortController();
    this.logger.log(`${this.workerId} started, concurrency=${concurrency}`);
    for (let i = 0; i < concurrency; i++) this.loops.push(this.loop());
    const leaseMs = this.config.get('JOB_LEASE_MS', { infer: true });
    this.reaper = setInterval(() => void this.reap(), leaseMs / 2);
  }

  /**
   * Graceful shutdown (SIGTERM, app.close()). Виконується до того, як Nest закриє пул з'єднань:
   * 1) нові задачі більше не беруться; 2) поточні мають WORKER_SHUTDOWN_GRACE_MS, щоб завершитись;
   * 3) ті, що не встигли, скасовуються й повертаються в чергу без зарахованої спроби — інший
   * воркер продовжить їх з останнього чекпоінта, не чекаючи, поки мине lease.
   */
  async beforeApplicationShutdown(): Promise<void> {
    if (this.stopping.signal.aborted) return;
    this.stopping.abort();
    clearInterval(this.reaper);
    const grace = this.config.get('WORKER_SHUTDOWN_GRACE_MS', { infer: true });
    const pending = () => [...this.inFlight.values()].map((j) => j.done);
    if (this.inFlight.size > 0) {
      this.logger.log(
        { jobs: this.inFlight.size, graceMs: grace },
        'shutting down: waiting for jobs in progress',
      );
      const finished = await Promise.race([
        Promise.allSettled(pending()).then(() => true),
        delay(grace, false),
      ]);
      if (!finished) {
        this.logger.warn(
          { jobs: this.inFlight.size },
          'shutdown grace period is over: releasing unfinished jobs',
        );
        for (const { keeper } of this.inFlight.values())
          keeper.abort(new ShutdownAbort());
        await Promise.race([
          Promise.allSettled(pending()),
          delay(RELEASE_WAIT_MS),
        ]);
      }
    }
    await Promise.allSettled(this.loops);
    this.loops = [];
  }

  /** Пауза, яку перериває початок завершення. */
  private async pause(ms: number): Promise<void> {
    try {
      await delay(ms, undefined, { signal: this.stopping.signal });
    } catch {
      // Завершення: виходимо з паузи одразу.
    }
  }

  /** Пауза опитування з відхиленням ±50%: воркери не стукають у БД синхронно. */
  private idle(): Promise<void> {
    const base = this.config.get('WORKER_POLL_INTERVAL_MS', { infer: true });
    return this.pause(base * (0.5 + Math.random()));
  }

  /** Повертає в чергу задачі зниклих воркерів. Помилка не зупиняє воркер — наступний прохід повторить. */
  private async reap(): Promise<void> {
    try {
      for (const job of await this.queue.reapExpired()) {
        this.metrics.leasesExpired.inc();
        this.metrics.observeFailure(job.outcome, 'lease_expired');
        await runWithCorrelationId(
          job.correlationId ?? newCorrelationId(),
          'job',
          () => {
            this.logger.warn(
              {
                jobId: job.id,
                executionId: job.executionId,
                attempt: job.attempts,
                outcome: job.outcome,
              },
              job.outcome === 'retry'
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
    while (!this.stopping.signal.aborted) {
      let job: ClaimedJob | null;
      try {
        job = await this.queue.claimNext(this.workerId);
      } catch (err) {
        // Задачі ще немає, тож і кореляційного контексту теж.
        this.logger.error({ error: toSafeError(err) }, 'job claim failed');
        await this.pause(1000);
        continue;
      }
      if (!job) {
        await this.idle();
        continue;
      }
      this.metrics.observeClaim(job);
      try {
        await this.process(job);
      } catch {
        // Уже залоговано в process() — у контексті задачі; лише пауза перед наступною.
        await this.pause(1000);
      }
    }
  }

  /**
   * Обробляє задачу в кореляційному контексті запиту/спрацювання, що її створило.
   * Непередбачена помилка логується тут же, всередині контексту (той самий correlationId,
   * jobId, executionId), і передається далі.
   */
  process(job: Job): Promise<void> {
    const keeper = new LeaseKeeper(
      this.queue,
      job,
      this.config.get('JOB_LEASE_MS', { infer: true }),
    );
    const done = runWithCorrelationId(
      job.correlationId ?? newCorrelationId(),
      'job',
      async () => {
        keeper.start();
        try {
          await this.processInContext(job, keeper.signal);
        } catch (err) {
          if (keeper.signal.reason instanceof ShutdownAbort) {
            await this.releaseOnShutdown(job);
            return;
          }
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
    const tracked = done.catch(() => undefined);
    this.inFlight.set(job.id, { keeper, done: tracked });
    void tracked.finally(() => this.inFlight.delete(job.id));
    return done;
  }

  private async releaseOnShutdown(job: Job): Promise<void> {
    try {
      await this.queue.release(job);
      this.logger.warn(
        { jobId: job.id, executionId: job.executionId },
        'job released on shutdown, another worker will continue it',
      );
    } catch (err) {
      // Не вдалося (lease уже забрано або БД недоступна): задачу поверне reaper, коли мине lease.
      this.logger.warn(
        { jobId: job.id, error: toSafeError(err) },
        'job could not be released on shutdown, it will be reclaimed after its lease expires',
      );
    }
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
    const runs = new Map(
      (await this.checkpoints.load(execution.id)).map((r) => [r.stepIndex, r]),
    );

    /** Крок, що виконується зараз (для запису провалу). */
    let current: StepRun | undefined;
    try {
      for (let i = 0; i < snapshot.steps.length; i++) {
        const step = snapshot.steps[i];
        const previous = runs.get(i);
        if (previous?.status === 'succeeded') {
          // Крок уже завершено в попередній спробі: беремо збережений результат, не виконуємо знову.
          ctx.steps[step.id] = previous.output;
          continue;
        }
        signal.throwIfAborted();
        if (step.type === 'delay') {
          const output = { waitedMs: step.ms };
          if (previous?.wakeAt) {
            // Пауза вже почалась раніше: завершуємо її, лише коли настав збережений момент.
            if (!(await this.checkpoints.wakeIfDue(job, previous, output)))
              return;
            ctx.steps[step.id] = output;
            continue;
          }
          const run = await this.checkpoints.startStep(job, i, step.id);
          if (step.ms > 0) {
            const wakeAt = await this.checkpoints.park(job, run, step.ms);
            this.logger.log(
              {
                jobId: job.id,
                executionId: job.executionId,
                stepId: step.id,
                wakeAt,
              },
              'delay step parked until its wake-up time',
            );
            return;
          }
          await this.checkpoints.checkpoint(job, run, output);
          ctx.steps[step.id] = output;
          continue;
        }
        current = await this.checkpoints.startStep(job, i, step.id);
        const startedAt = Date.now();
        let output: unknown;
        try {
          output = await this.executor.execute(step, ctx, {
            signal,
            idempotencyKey: current.idempotencyKey,
          });
        } catch (err) {
          this.metrics.observeStep(step.type, 'failed', startedAt);
          throw err;
        }
        this.metrics.observeStep(step.type, 'succeeded', startedAt);
        // Далі — збережене значення (як і після відновлення з чекпоінта), а не сирий результат.
        ctx.steps[step.id] = await this.checkpoints.checkpoint(
          job,
          current,
          output,
        );
        current = undefined;
      }
      const last = snapshot.steps[snapshot.steps.length - 1];
      await this.checkpoints.finish(job, ctx.steps[last.id]);
    } catch (err) {
      if (err instanceof LeaseLostError || signal.aborted) throw err;
      // Тенант бачить лише помилки самого кроку; текст будь-якої іншої (БД, ORM, баг) може
      // містити внутрішні деталі — він іде лише в лог (нижче, з кореляційним ID).
      const stepError = err instanceof StepError;
      const outcome = await this.checkpoints.fail(
        job,
        current,
        stepError ? err.message : INTERNAL_STEP_ERROR,
        stepError ? err.retryable : true,
        stepError ? err.retryAfterMs : undefined,
      );
      this.metrics.observeFailure(outcome, 'step_error');
      this.logger.warn(
        {
          jobId: job.id,
          executionId: job.executionId,
          stepId: current?.stepId,
          attempt: job.attempts,
          outcome,
          error: toSafeError(err),
        },
        outcome === 'retry' ? 'step failed, will retry' : 'step failed',
      );
    }
  }
}
