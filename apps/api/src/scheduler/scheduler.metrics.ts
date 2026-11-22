import { Injectable } from '@nestjs/common';
import { Counter, Histogram } from 'prom-client';
import { MetricsService } from '../observability/metrics.service';

/** Що сталося з одним моментом розкладу (мітка `outcome`). */
export type FiringOutcome =
  'created' | 'existing' | 'missed_skipped' | 'missed_run_once';
export type ScheduleBlockedReason = 'queue_full' | 'outbox_full';

/**
 * Метрики планувальника (процес API, docs/operations.md, «Метрики»). Мітки — лише з обмеженого набору значень,
 * без ідентифікаторів тенантів і workflow. Лічильники процесу: між інстансами — `sum`.
 */
@Injectable()
export class SchedulerMetrics {
  /** Оброблені моменти розкладу за результатом. */
  readonly firings: Counter<'outcome'>;
  /** Спроби спрацювання, відкладені через квоту черги або outbox (курсор не рухається). */
  readonly blocked: Counter<'reason'>;
  /** Розклади, які не вдалося обробити (невалідний вираз, помилка БД обробки workflow). */
  readonly errors: Counter<'reason'>;
  /** Від запланованого моменту до створення виконання, за годинником БД. */
  readonly lag: Histogram;
  /** Тривалість одного тіку. */
  readonly tickDuration: Histogram;

  constructor(metrics: MetricsService) {
    const registers = [metrics.registry];
    this.firings = new Counter({
      name: 'flowforge_schedule_firings_total',
      help: 'Schedule moments processed by the scheduler, by outcome',
      labelNames: ['outcome'],
      registers,
    });
    this.blocked = new Counter({
      name: 'flowforge_schedule_blocked_total',
      help: 'Schedule firings held back without moving the schedule progress, by reason',
      labelNames: ['reason'],
      registers,
    });
    this.errors = new Counter({
      name: 'flowforge_schedule_errors_total',
      help: 'Schedules that could not be processed, by reason',
      labelNames: ['reason'],
      registers,
    });
    this.lag = new Histogram({
      name: 'flowforge_schedule_lag_seconds',
      help: 'Time from a scheduled moment to the creation of its execution',
      buckets: [0.1, 0.5, 1, 5, 15, 30, 60, 300, 900, 3600, 86400],
      registers,
    });
    this.tickDuration = new Histogram({
      name: 'flowforge_scheduler_tick_duration_seconds',
      help: 'Duration of one scheduler tick',
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 15, 30, 60],
      registers,
    });
    for (const outcome of [
      'created',
      'existing',
      'missed_skipped',
      'missed_run_once',
    ])
      this.firings.inc({ outcome }, 0);
    this.blocked.inc({ reason: 'queue_full' }, 0);
    this.blocked.inc({ reason: 'outbox_full' }, 0);
    for (const reason of ['invalid_schedule', 'database'])
      this.errors.inc({ reason }, 0);
  }
}
