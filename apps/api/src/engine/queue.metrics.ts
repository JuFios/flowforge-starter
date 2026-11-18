import { Injectable } from '@nestjs/common';
import { Counter, Histogram } from 'prom-client';
import { MetricsService } from '../observability/metrics.service';
import type { StepDefinition } from '../entities';
import type { FailureOutcome } from './job-queue.service';

/**
 * Метрики черги й кроків воркера (у реєстрі MetricsService, видно на `/metrics` воркера).
 * Мітки — лише з обмеженого набору значень (тип кроку, результат, причина), без ID тенантів і
 * задач: кардинальність метрик не залежить від кількості даних. Глибина черги за тенантом —
 * окрема метрика планування.
 */
@Injectable()
export class QueueMetrics {
  /** Від моменту, коли задача стала готовою (`runAt`), до захоплення воркером — за годинником БД. */
  readonly claimLatency: Histogram;
  readonly stepDuration: Histogram<'type' | 'outcome'>;
  /** Спроби, після яких задачу поставлено на повтор. */
  readonly retries: Counter<'reason'>;
  /** Задачі, що вичерпали ліміт спроб (стан `dead`). */
  readonly dead: Counter<'reason'>;
  /** Lease-и, повернуті reaper-ом (воркер зник посеред задачі). */
  readonly leasesExpired: Counter;
  /** Невдалі спроби захоплення (БД недоступна): видно збій, навіть коли лог стримує backoff. */
  readonly claimFailures: Counter;
  /** Завершені задачі, видалені після JOB_RETENTION_DAYS. */
  readonly jobsPurged: Counter;
  /** Завершені виконання (з кроками й задачами), видалені після EXECUTION_RETENTION_DAYS. */
  readonly executionsPurged: Counter;

  constructor(metrics: MetricsService) {
    const registers = [metrics.registry];
    this.claimLatency = new Histogram({
      name: 'flowforge_job_claim_latency_seconds',
      help: 'Time from a job becoming ready (runAt) to a worker claiming it',
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300],
      registers,
    });
    this.stepDuration = new Histogram({
      name: 'flowforge_step_duration_seconds',
      help: 'Duration of one step attempt, by step type and outcome',
      labelNames: ['type', 'outcome'],
      buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15, 30],
      registers,
    });
    this.retries = new Counter({
      name: 'flowforge_job_retries_total',
      help: 'Failed job attempts scheduled for a retry, by reason',
      labelNames: ['reason'],
      registers,
    });
    this.dead = new Counter({
      name: 'flowforge_jobs_dead_total',
      help: 'Jobs that exhausted their attempts, by the reason of the last failure',
      labelNames: ['reason'],
      registers,
    });
    this.leasesExpired = new Counter({
      name: 'flowforge_job_leases_expired_total',
      help: 'Job leases reclaimed by the reaper after a worker stopped renewing them',
      registers,
    });
    this.claimFailures = new Counter({
      name: 'flowforge_job_claim_failures_total',
      help: 'Failed attempts to claim a job (database unavailable or failing)',
      registers,
    });
    this.jobsPurged = new Counter({
      name: 'flowforge_jobs_purged_total',
      help: 'Finished jobs deleted after the retention period',
      registers,
    });
    this.executionsPurged = new Counter({
      name: 'flowforge_executions_purged_total',
      help: 'Finished executions deleted with their steps and jobs after the history retention period',
      registers,
    });
    // Нульові значення відомих міток: ряд є з самого старту, rate()/increase() коректні.
    for (const reason of ['step_error', 'lease_expired']) {
      this.retries.inc({ reason }, 0);
      this.dead.inc({ reason }, 0);
    }
  }

  observeClaim(job: { runAt: Date; claimedAt?: Date }): void {
    if (!job.claimedAt) return;
    const seconds = (job.claimedAt.getTime() - job.runAt.getTime()) / 1000;
    this.claimLatency.observe(Math.max(0, seconds));
  }

  observeStep(
    type: StepDefinition['type'],
    outcome: 'succeeded' | 'failed',
    startedAtMs: number,
    finishedAtMs = Date.now(),
  ): void {
    this.stepDuration.observe(
      { type, outcome },
      Math.max(0, finishedAtMs - startedAtMs) / 1000,
    );
  }

  observeFailure(
    outcome: FailureOutcome,
    reason: 'step_error' | 'lease_expired',
  ): void {
    if (outcome === 'retry') this.retries.inc({ reason });
    if (outcome === 'dead') this.dead.inc({ reason });
  }
}
