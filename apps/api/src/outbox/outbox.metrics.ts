import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram } from 'prom-client';
import { MetricsService } from '../observability/metrics.service';
import { SystemDb } from '../tenancy/system-db';

/** Результат однієї спроби доставки (мітка `outcome`). */
export const ATTEMPT_OUTCOMES = [
  'delivered',
  'http_error',
  'redirect',
  'timeout',
  'network',
  'denied',
  'paused',
  'aborted',
  'stale',
] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

/** Скільки знімок беклогу вважається свіжим (скрейпи частіші — з кешу). */
const CACHE_MS = 5_000;

type Backlog = Awaited<ReturnType<SystemDb['outboxBacklog']>>;

/**
 * Метрики доставки сповіщень (процес воркера, docs/operations.md, «Метрики»). Мітки — лише з обмеженого набору:
 * результат спроби, стан, ідентифікатор тенанта для беклогу (як у глибини черги); без URL, секретів
 * і ідентифікаторів подій. Лічильники — процесу (між воркерами `sum`); gauge беклогу читається з БД
 * і однаковий на всіх воркерах (між воркерами `max`).
 */
@Injectable()
export class OutboxMetrics {
  readonly attempts: Counter<'outcome'>;
  readonly attemptDuration: Histogram<'outcome'>;
  /** Невдалі захоплення спроб (БД недоступна). */
  readonly claimFailures: Counter;
  /** Підказки `dueAt`, які захоплення знайшло застарілими й перерахувало. */
  readonly dueRepairs: Counter;
  /** Видалені доставлені та скасовані події (після OUTBOX_RETENTION_DAYS). */
  readonly purged: Counter;
  readonly collectErrors: Counter;
  private cached?: { at: number; backlog: Backlog };
  private inFlight?: Promise<Backlog>;
  private collecting?: Promise<void>;

  constructor(
    metrics: MetricsService,
    private readonly system: SystemDb,
  ) {
    const registers = [metrics.registry];
    this.attempts = new Counter({
      name: 'flowforge_outbox_attempts_total',
      help: 'Notification delivery attempts, by outcome',
      labelNames: ['outcome'],
      registers,
    });
    this.attemptDuration = new Histogram({
      name: 'flowforge_outbox_attempt_duration_seconds',
      help: 'Duration of one notification delivery attempt, by outcome',
      labelNames: ['outcome'],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
      registers,
    });
    this.claimFailures = new Counter({
      name: 'flowforge_outbox_claim_failures_total',
      help: 'Failed attempts to claim a notification delivery (database unavailable)',
      registers,
    });
    this.dueRepairs = new Counter({
      name: 'flowforge_outbox_due_repairs_total',
      help: 'Stale per-tenant due hints recomputed by a delivery claim',
      registers,
    });
    this.purged = new Counter({
      name: 'flowforge_outbox_purged_total',
      help: 'Delivered and cancelled notification events deleted after the retention period',
      registers,
    });
    // Gauge-і — першими: лічильник помилок нижче чекає на їхній збір (як у глибини черги).
    const events: Gauge<'state'> = new Gauge({
      name: 'flowforge_outbox_events',
      help: 'Undelivered notification events: pending and being sent',
      labelNames: ['state'],
      registers,
      collect: () => {
        this.collecting = this.fill(events, pending, oldest);
        return this.collecting;
      },
    });
    const pending: Gauge<'tenant_id'> = new Gauge({
      name: 'flowforge_outbox_pending',
      help: 'Undelivered notification events of each tenant',
      labelNames: ['tenant_id'],
      registers,
      // Реєстр збирає метрики паралельно: значення заповнює збір першого gauge.
      collect: async () => {
        await this.collecting;
      },
    });
    const oldest = new Gauge({
      name: 'flowforge_outbox_oldest_pending_age_seconds',
      help: 'Age of the oldest undelivered notification event (0 when none)',
      registers,
      collect: async () => {
        await this.collecting;
      },
    });
    this.collectErrors = new Counter({
      name: 'flowforge_outbox_backlog_collect_errors_total',
      help: 'Failed reads of the notification backlog',
      registers,
      collect: async () => {
        await this.collecting;
      },
    });
    for (const outcome of ATTEMPT_OUTCOMES) this.attempts.inc({ outcome }, 0);
  }

  observeAttempt(outcome: AttemptOutcome, startedAtMs: number): void {
    this.attempts.inc({ outcome });
    this.attemptDuration.observe(
      { outcome },
      Math.max(0, performance.now() - startedAtMs) / 1000,
    );
  }

  private async fill(
    events: Gauge<'state'>,
    pending: Gauge<'tenant_id'>,
    oldest: Gauge,
  ): Promise<void> {
    events.reset();
    pending.reset();
    oldest.reset();
    let backlog: Backlog;
    try {
      backlog = await this.backlog();
    } catch {
      return;
    }
    let waiting = 0,
      sending = 0,
      first = Infinity;
    for (const row of backlog) {
      waiting += row.pending;
      sending += row.sending;
      first = Math.min(first, row.oldest.getTime());
      pending.set({ tenant_id: row.tenantId }, row.pending + row.sending);
    }
    events.set({ state: 'pending' }, waiting);
    events.set({ state: 'sending' }, sending);
    oldest.set(
      Number.isFinite(first) ? Math.max(0, (Date.now() - first) / 1000) : 0,
    );
  }

  private async read(): Promise<Backlog> {
    try {
      return await this.system.outboxBacklog();
    } catch (err) {
      this.collectErrors.inc();
      throw err;
    }
  }

  private async backlog(): Promise<Backlog> {
    if (this.cached && performance.now() - this.cached.at < CACHE_MS)
      return this.cached.backlog;
    this.inFlight ??= this.read().finally(() => {
      this.inFlight = undefined;
    });
    const backlog = await this.inFlight;
    this.cached = { at: performance.now(), backlog };
    return backlog;
  }
}
