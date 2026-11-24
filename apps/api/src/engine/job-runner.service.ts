import {
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { setMaxListeners } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { IdleLoops } from '../common/idle-loops';
import { EnvironmentVariables, MAX_TIMER_MS } from '../config/env.validation';
import { Job, StepRun } from '../entities';
import {
  newCorrelationId,
  runWithCorrelationId,
} from '../observability/correlation';
import { toSafeError } from '../observability/safe-error';
import { TenantDb } from '../tenancy/tenant-db';
import { CONTEXT_BYTES } from './transform-profile';
import { CheckpointService } from './checkpoint.service';
import {
  backoffMs,
  ClaimedJob,
  JobQueueService,
  LeaseLostError,
} from './job-queue.service';
import { LeaseKeeper } from './lease-keeper';
import { QueueMetrics } from './queue.metrics';
import { StepError, StepExecutor } from './step-executor';
import { StepContext } from './template';
import { JOBS_READY, WorkSignals } from './work-signals.service';

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

/**
 * Відступ після невдалого захоплення (БД недоступна): експоненційний, з jitter, від 1 с до 30 с.
 * Спільний для всіх циклів воркера, тож навіть 64 цикли дають одну перевірку БД і один рядок логу.
 */
const CLAIM_BACKOFF = { baseMs: 1_000, maxMs: 30_000 };

/**
 * Пауза перед новою спробою, коли всіх кандидатів саме захоплюють інші (рядки тримають їхні
 * короткі транзакції), мс, з відхиленням ±50%: набагато менша за інтервал опитування, бо готові
 * задачі є, але без холостого циклу.
 */
const BUSY_RETRY_MS = 20;

@Injectable()
export class JobRunnerService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(JobRunnerService.name);
  readonly workerId = `worker-${randomUUID().slice(0, 8)}`;
  /** Скасовується на початку завершення: цикли перестають брати задачі й виходять із пауз. */
  private stopping = new AbortController();
  /** Простій циклів: опитує один черговий, решта чекають на роботу (common/idle-loops.ts). */
  private idleLoops = new IdleLoops(this.stopping.signal);
  /** Відписка від підказок LISTEN поточного запуску. */
  private detachSignals?: () => void;
  private loops: Promise<void>[] = [];
  private readonly inFlight = new Set<{
    keeper: LeaseKeeper;
    done: Promise<void>;
  }>();
  private readonly maintenanceTimers = new Set<NodeJS.Timeout>();
  private readonly maintenanceRuns = new Set<Promise<void>>();
  /** Невдалі захоплення поспіль (спільно для всіх циклів); 0 — захоплення працює. */
  private claimFailures = 0;
  /** До цього моменту (Date.now()) цикли не захоплюють задач після невдалого захоплення. */
  private claimRetryAt = 0;
  /** Один цикл уже перевіряє, чи БД відновилась; решта чекають на результат. */
  private claimProbe = false;

  constructor(
    private readonly queue: JobQueueService,
    private readonly executor: StepExecutor,
    private readonly db: TenantDb,
    private readonly checkpoints: CheckpointService,
    private readonly config: ConfigService<EnvironmentVariables, true>,
    private readonly metrics: QueueMetrics,
    @Optional() private readonly signals?: WorkSignals,
  ) {}

  start(
    concurrency = this.config.get('WORKER_CONCURRENCY', { infer: true }),
  ): void {
    this.stopping = new AbortController();
    this.idleLoops = new IdleLoops(this.stopping.signal);
    // Кожен цикл може одночасно чекати зі своїм слухачем abort.
    if (concurrency > 0) setMaxListeners(concurrency + 1, this.stopping.signal);
    if (this.signals && concurrency > 0) {
      // Нова готова задача або відновлений LISTEN (сповіщення за час розриву загублено) — будимо
      // чергового циклу одразу, не чекаючи інтервалу опитування.
      const idle = this.idleLoops;
      const ready = () => idle.signal();
      const available = (up: boolean) => {
        if (up) idle.signal();
      };
      const events = this.signals.events;
      events.on(JOBS_READY, ready);
      events.on('available', available);
      this.detachSignals = () => {
        events.off(JOBS_READY, ready);
        events.off('available', available);
      };
      this.signals.start();
    }
    this.logger.log(`${this.workerId} started, concurrency=${concurrency}`);
    for (let i = 0; i < concurrency; i++) this.loops.push(this.loop());
    const leaseMs = this.config.get('JOB_LEASE_MS', { infer: true });
    const cleanupMs = this.config.get('JOB_CLEANUP_INTERVAL_MS', {
      infer: true,
    });
    this.scheduleMaintenance(
      () => this.reap(),
      () => leaseMs / 2,
    );
    this.scheduleMaintenance(
      () => this.purgeFinished(),
      () => Math.min(MAX_TIMER_MS, cleanupMs * (0.5 + Math.random())),
    );
    let moreVersions = true;
    this.scheduleMaintenance(
      async () => {
        moreVersions = false;
        // Пауза між проходами — чверть інтервалу очищення: коротша за найменшу паузу циклу
        // (0,5×), але довша за повторні виклики воркерів, які ще продовжували завершений прохід.
        const { deleted, more } = await this.queue.purgeWorkflowVersions(
          Math.floor(cleanupMs / 4),
        );
        moreVersions = more;
        if (deleted > 0)
          this.logger.log(
            { deleted },
            'deleted unreferenced workflow versions',
          );
      },
      () =>
        moreVersions
          ? 1_000 + Math.random() * 1_000
          : Math.min(MAX_TIMER_MS, cleanupMs * (0.5 + Math.random())),
    );
  }

  /** Кожен прохід має один таймер або один активний запит. Завершення чекає на активні проходи. */
  private scheduleMaintenance(
    run: () => Promise<void>,
    interval: () => number,
  ): void {
    if (this.stopping.signal.aborted) return;
    const timer = setTimeout(() => {
      this.maintenanceTimers.delete(timer);
      const active = run()
        .catch((err: unknown) => {
          this.logger.error(
            { error: toSafeError(err) },
            'worker maintenance failed',
          );
        })
        .finally(() => {
          this.maintenanceRuns.delete(active);
          this.scheduleMaintenance(run, interval);
        });
      this.maintenanceRuns.add(active);
    }, interval());
    this.maintenanceTimers.add(timer);
  }

  /**
   * Видаляє старі завершені задачі, а якщо увімкнено (EXECUTION_RETENTION_DAYS > 0), — і стару
   * історію виконань. Помилка не зупиняє воркер — наступне очищення повторить.
   */
  private async purgeFinished(): Promise<void> {
    const days = this.config.get('JOB_RETENTION_DAYS', { infer: true });
    try {
      const deleted = await this.queue.purgeFinished(
        days,
        this.stopping.signal,
      );
      this.metrics.jobsPurged.inc(deleted);
      if (deleted > 0)
        this.logger.log(
          { deleted, retentionDays: days },
          'deleted finished jobs past their retention period',
        );
    } catch (err) {
      this.logger.error({ error: toSafeError(err) }, 'job cleanup failed');
    }
    const historyDays = this.config.get('EXECUTION_RETENTION_DAYS', {
      infer: true,
    });
    if (!historyDays) return;
    try {
      const deleted = await this.queue.purgeExecutions(
        historyDays,
        this.stopping.signal,
      );
      this.metrics.executionsPurged.inc(deleted);
      if (deleted > 0)
        this.logger.log(
          { deleted, retentionDays: historyDays },
          'deleted finished executions past their retention period',
        );
    } catch (err) {
      this.logger.error(
        { error: toSafeError(err) },
        'execution history cleanup failed',
      );
    }
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
    this.detachSignals?.();
    for (const timer of this.maintenanceTimers) clearTimeout(timer);
    this.maintenanceTimers.clear();
    const grace = this.config.get('WORKER_SHUTDOWN_GRACE_MS', { infer: true });
    const pending = () => [...this.inFlight.values()].map((j) => j.done);
    if (this.inFlight.size > 0) {
      this.logger.log(
        { jobs: this.inFlight.size, graceMs: grace },
        'shutting down: waiting for jobs in progress',
      );
      const finished = await Promise.race([
        Promise.allSettled(pending()).then(() => true),
        delay(grace, false, { ref: false }),
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
          delay(RELEASE_WAIT_MS, undefined, { ref: false }),
        ]);
      }
    }
    await Promise.allSettled([...this.loops, ...this.maintenanceRuns]);
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

  /**
   * Порожня черга: черговий цикл чекає інтервал опитування з відхиленням ±50% (воркери не стукають
   * у БД синхронно) або підказку про нову задачу, решта — доки їх не розбудить цикл, що отримав
   * задачу (docs/architecture.md, «Черговий цикл і пробудження»).
   */
  private idle(): Promise<void> {
    const base = this.config.get('WORKER_POLL_INTERVAL_MS', { infer: true });
    return this.idleLoops.idle(base * (0.5 + Math.random()));
  }

  /** Повертає в чергу задачі зниклих воркерів. Помилка не зупиняє воркер — наступний прохід повторить. */
  private async reap(): Promise<void> {
    try {
      for (const job of await this.queue.reapExpired(this.stopping.signal)) {
        this.metrics.leasesExpired.inc();
        if (job.outcome !== 'done')
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
                : job.outcome === 'done'
                  ? 'lease expired after the final checkpoint, execution finalized'
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
      const job = await this.claim();
      if (this.stopping.signal.aborted) {
        if (job) await this.releaseOnShutdown(job);
        return;
      }
      // undefined — задачу не захоплено (кандидатів чи їхні готові задачі тримають інші
      // транзакції, промоцію дозрілих тенантів ще не завершено, відступ після збою або
      // завершення): коротка пауза з відхиленням і нове коло, без повного
      // інтервалу опитування — готові задачі є.
      if (job === undefined) {
        await this.pause(BUSY_RETRY_MS * (0.5 + Math.random()));
        continue;
      }
      if (!job) {
        await this.idle();
        continue;
      }
      this.metrics.observeClaim(job);
      // Задачу отримано: наступний цикл перевірить, чи є ще (ланцюгове пробудження).
      this.idleLoops.worked();
      try {
        await this.process(job);
      } catch {
        // Уже залоговано в process() — у контексті задачі; лише пауза перед наступною.
        await this.pause(1000);
      }
    }
  }

  /**
   * Захоплює наступну задачу з урахуванням спільного відступу після збоїв. null — черга порожня,
   * undefined — задачу не захоплено (відступ, збій або завершення воркера), цикл іде на наступне коло.
   */
  private async claim(): Promise<ClaimedJob | null | undefined> {
    let probe = false;
    if (this.claimFailures > 0) {
      const wait = this.claimRetryAt - Date.now();
      // Під час перевірки іншим циклом — коротка пауза опитування, а не холостий цикл.
      if (wait > 0 || this.claimProbe) {
        await this.pause(
          Math.max(
            wait,
            this.config.get('WORKER_POLL_INTERVAL_MS', { infer: true }),
          ),
        );
        return undefined;
      }
      this.claimProbe = probe = true;
    }
    try {
      const job = await this.queue.claimNext(this.workerId);
      if (this.claimFailures > 0) {
        this.logger.log(
          { consecutiveFailures: this.claimFailures },
          'job claim recovered',
        );
        this.claimFailures = 0;
      }
      return job;
    } catch (err) {
      this.metrics.claimFailures.inc();
      // Збій під час уже запланованого відступу — той самий збій, що його спричинив (цикли
      // почали захоплення одночасно): не рахуємо й не логуємо вдруге.
      if (probe || Date.now() >= this.claimRetryAt) {
        this.claimFailures += 1;
        const retryInMs = backoffMs(this.claimFailures, CLAIM_BACKOFF);
        this.claimRetryAt = Date.now() + retryInMs;
        // Задачі ще немає, тож і кореляційного контексту теж.
        this.logger.error(
          {
            error: toSafeError(err),
            consecutiveFailures: this.claimFailures,
            retryInMs,
          },
          'job claim failed',
        );
      }
      return undefined;
    } finally {
      if (probe) this.claimProbe = false;
    }
  }

  /**
   * Обробляє задачу в кореляційному контексті запиту/спрацювання, що її створило.
   * Непередбачена помилка логується тут же, всередині контексту (той самий correlationId,
   * jobId, executionId), і передається далі.
   */
  process(job: ClaimedJob): Promise<void> {
    const keeper = new LeaseKeeper(
      this.queue,
      job,
      this.config.get('JOB_LEASE_MS', { infer: true }),
      job.leaseStartedAt,
    );
    const done = runWithCorrelationId(
      job.correlationId ?? newCorrelationId(),
      'job',
      async () => {
        keeper.start();
        try {
          keeper.assertActive();
          await this.processInContext(job, keeper);
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
    const attempt = { keeper, done: done.catch(() => undefined) };
    // Те саме завдання може мати новий lease до завершення старої спроби.
    this.inFlight.add(attempt);
    void attempt.done.then(() => this.inFlight.delete(attempt));
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

  private async processInContext(job: Job, keeper: LeaseKeeper): Promise<void> {
    const signal = keeper.signal;
    this.logger.log(
      { jobId: job.id, executionId: job.executionId, attempt: job.attempts },
      'processing job',
    );
    /** Крок, що виконується зараз (для запису провалу). */
    let current: StepRun | undefined;
    let delayAttemptStartedAt: number | undefined;
    let finalOutput: unknown;
    try {
      // Виконання, його знімок і чекпоінти — одним читанням у контексті тенанта задачі, з явним
      // предикатом tenantId (композитні FK гарантують, що вони належать тому самому тенанту).
      const { input, steps, history } = await this.db.run(job.tenantId, (em) =>
        this.checkpoints.resume(em, job),
      );
      const ctx: StepContext = { input, steps: {} };
      // Знімок версії, зафіксований під час створення виконання, а не поточний стан workflow.
      // Без знімку виконання запускати не можна: `{ id: undefined }` TypeORM виконав би без умови
      // й повернув першу-ліпшу версію. CHECK у БД такого стану не допускає — це остання лінія
      // захисту, і провал записується одразу, без повторів.
      if (!steps)
        throw new StepError(
          'execution has no workflow version snapshot',
          false,
        );
      if (history.some((run) => steps[run.stepIndex]?.id !== run.stepId))
        throw new StepError(
          'checkpoint does not match the workflow version',
          false,
        );
      let contextBytes = Buffer.byteLength(JSON.stringify(ctx));
      const remember = (id: string, value: unknown) => {
        contextBytes +=
          Buffer.byteLength(JSON.stringify(value ?? null)) +
          Buffer.byteLength(JSON.stringify(id)) +
          2;
        ctx.steps[id] = value;
      };
      const runs = new Map(history.map((run) => [run.stepIndex, run]));
      for (let i = 0; i < steps.length; i++) {
        if (contextBytes > CONTEXT_BYTES)
          throw new StepError('step context exceeds the byte limit', false);
        const step = steps[i];
        const previous = runs.get(i);
        if (previous?.status === 'succeeded') {
          // Крок уже завершено в попередній спробі: беремо збережений результат, не виконуємо знову.
          remember(step.id, previous.output);
          continue;
        }
        keeper.assertActive();
        if (step.type === 'delay') {
          const output = { waitedMs: step.ms };
          delayAttemptStartedAt = Date.now();
          current = previous?.wakeAt
            ? previous
            : await this.checkpoints.startStep(job, i, step.id);
          if (!current.wakeAt && step.ms > 0) {
            const wakeAt = await this.checkpoints.park(job, current, step.ms);
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
          const saved = current.wakeAt
            ? await this.checkpoints.wakeIfDue(job, current, output)
            : await this.checkpoints.checkpoint(job, current, output);
          if (!saved) return;
          this.metrics.observeStep(
            'delay',
            'succeeded',
            current.startedAt.getTime(),
            saved.finishedAt.getTime(),
          );
          remember(step.id, saved.output);
          current = undefined;
          delayAttemptStartedAt = undefined;
          continue;
        }
        current = await this.checkpoints.startStep(job, i, step.id);
        const startedAt = Date.now();
        let output: unknown;
        try {
          keeper.assertActive();
          output = await this.executor.execute(step, ctx, {
            signal,
            idempotencyKey: current.idempotencyKey,
            execution: { executionId: job.executionId, tenantId: job.tenantId },
          });
        } catch (err) {
          this.metrics.observeStep(step.type, 'failed', startedAt);
          throw err;
        }
        this.metrics.observeStep(step.type, 'succeeded', startedAt);
        // Далі — збережене значення (як і після відновлення з чекпоінта), а не сирий результат.
        const saved = await this.checkpoints.checkpoint(job, current, output);
        remember(step.id, saved.output);
        current = undefined;
      }
      const last = steps[steps.length - 1];
      finalOutput = ctx.steps[last.id];
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
      if (outcome === 'checkpointed') {
        this.logger.warn(
          { jobId: job.id, stepId: current?.stepId, error: toSafeError(err) },
          'checkpoint already committed, resuming from the next step',
        );
        return;
      }
      if (current && delayAttemptStartedAt !== undefined)
        this.metrics.observeStep('delay', 'failed', delayAttemptStartedAt);
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
      return;
    }
    // Усі кроки вже записано. Помилка окремого COMMIT завершення лишає роботу
    // reaper-у, який фіналізує execution зі збереженого результату.
    await this.checkpoints.finish(job, finalOutput);
  }
}
