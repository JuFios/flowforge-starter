import { Injectable } from '@nestjs/common';
import { Counter } from 'prom-client';
import { MetricsService } from '../observability/metrics.service';

/** Метрики лімітів API (docs/operations.md, «Метрики»). */
@Injectable()
export class LimitsMetrics {
  /** Запити, відхилені лімітом частоти (`tenant`, `webhook`, `admin`, `auth-failures`). */
  readonly rateLimited: Counter<'throttler'>;
  /**
   * Постановки, відхилені лімітом черги (`queue_full`) чи квотою outbox (`outbox_full`), за джерелом
   * (`api`, `webhook`, `cron`, `retry`, `redeliver`).
   */
  readonly enqueueRejected: Counter<'reason' | 'trigger'>;

  constructor(metrics: MetricsService) {
    const registers = [metrics.registry];
    this.rateLimited = new Counter({
      name: 'flowforge_rate_limited_total',
      help: 'Requests rejected with 429 by a rate limit',
      labelNames: ['throttler'],
      registers,
    });
    this.enqueueRejected = new Counter({
      name: 'flowforge_enqueue_rejected_total',
      help: 'Executions or redeliveries not accepted because the tenant queue or outbox quota was full',
      labelNames: ['reason', 'trigger'],
      registers,
    });
  }
}
