import {
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { setMaxListeners } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { IdleLoops } from '../common/idle-loops';
import { EnvironmentVariables, MAX_TIMER_MS } from '../config/env.validation';
import { backoffMs, retryDelayMs } from '../engine/job-queue.service';
import { outboundHttp } from '../engine/outbound-http';
import { parseRetryAfter } from '../engine/retry-after';
import { StepError } from '../engine/step-error';
import { OUTBOX_READY, WorkSignals } from '../engine/work-signals.service';
import {
  newCorrelationId,
  runWithCorrelationId,
} from '../observability/correlation';
import { toSafeError } from '../observability/safe-error';
import { SystemDb } from '../tenancy/system-db';
import { TenantDb } from '../tenancy/tenant-db';
import { AttemptOutcome, OutboxMetrics } from './outbox.metrics';
import {
  ATTEMPT_HEADER,
  EVENT_ID_HEADER,
  signatureHeader,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
} from './outbox-signature';

/** Захоплена спроба: ідентифікатори й fencing-токен (`claim_outbox_event`). */
export interface ClaimedEvent {
  id: string;
  tenantId: string;
  leaseToken: string;
  attempt: number;
  correlationId: string | null;
}

/** Подія й налаштування тенанта, прочитані одним запитом на початку спроби. */
interface AttemptContext {
  payload: string;
  url: string | null;
  enabled: boolean | null;
  revision: number | null;
  secretKeyId: string | null;
  secret: string | null;
  nextSecretKeyId: string | null;
  nextSecret: string | null;
  now: number;
}

/** Відступ після невдалого захоплення (БД недоступна), як у циклів задач. */
const CLAIM_BACKOFF = { baseMs: 1_000, maxMs: 30_000 };
/** Скільки доставлених подій видаляє одна транзакція очищення. */
const PURGE_BATCH = 1_000;

/**
 * Відправник сповіщень із transactional outbox (README 3.3.9), у процесі воркера.
 *
 * Спроба: коротка транзакція захоплення (`claim_outbox_event`: справедливо між тенантами, не більше
 * OUTBOX_TENANT_IN_FLIGHT одночасних спроб тенанта, новий fencing-токен, lease) → коротка
 * транзакція читання події й чинних налаштувань → HTTP поза транзакцією → транзакція результату з
 * перевіркою токена. Відправник, що впав чи завис, не втрачає подію: після lease її захоплює інший
 * з тим самим ID і тими самими байтами, а його запізніла відповідь не перезапише новішого результату.
 */
@Injectable()
export class OutboxSender implements BeforeApplicationShutdown {
  private readonly logger = new Logger(OutboxSender.name);
  readonly senderId = `outbox-${randomUUID().slice(0, 8)}`;
  /** Скасовується на початку завершення: цикли перестають брати нові спроби. */
  private stopping = new AbortController();
  /** Скасовується, коли пільговий час завершення вичерпано: обриває запити, що ще тривають. */
  private cancel = new AbortController();
  /** Простій циклів: опитує один черговий, решта чекають на роботу (common/idle-loops.ts). */
  private idleLoops = new IdleLoops(this.stopping.signal);
  /** Відписка від підказок LISTEN поточного запуску. */
  private detachSignals?: () => void;
  private loops: Promise<void>[] = [];
  private readonly active = new Set<Promise<void>>();
  private purgeTimer?: NodeJS.Timeout;
  private purging?: Promise<void>;
  private claimFailures = 0;
  private claimRetryAt = 0;

  constructor(
    private readonly system: SystemDb,
    private readonly db: TenantDb,
    private readonly config: ConfigService<EnvironmentVariables, true>,
    private readonly metrics: OutboxMetrics,
    @Optional() private readonly signals?: WorkSignals,
  ) {}

  private get leaseMs(): number {
    // HTTP обмежений таймаутом, тож lease з запасом покриває всю спробу без heartbeat.
    return (
      2 * this.config.get('OUTBOX_HTTP_TIMEOUT_MS', { infer: true }) + 5_000
    );
  }

  start(
    concurrency = this.config.get('OUTBOX_CONCURRENCY', { infer: true }),
  ): void {
    this.stopping = new AbortController();
    this.cancel = new AbortController();
    this.idleLoops = new IdleLoops(this.stopping.signal);
    if (concurrency > 0) {
      setMaxListeners(concurrency + 2, this.stopping.signal);
      setMaxListeners(concurrency + 1, this.cancel.signal);
    }
    if (this.signals && concurrency > 0) {
      const idle = this.idleLoops;
      const ready = () => idle.signal();
      const available = (up: boolean) => {
        if (up) idle.signal();
      };
      const events = this.signals.events;
      events.on(OUTBOX_READY, ready);
      events.on('available', available);
      this.detachSignals = () => {
        events.off(OUTBOX_READY, ready);
        events.off('available', available);
      };
      this.signals.start();
    }
    this.logger.log(`${this.senderId} started, concurrency=${concurrency}`);
    for (let i = 0; i < concurrency; i++) this.loops.push(this.loop());
    if (concurrency > 0) this.schedulePurge();
  }

  /**
   * Завершення: нових спроб немає; поточні мають WORKER_SHUTDOWN_GRACE_MS, потім їхні запити
   * обриваються, а подія повертається в чергу (`aborted`). Те, що не встигло записатись, поверне
   * спливання lease.
   */
  async beforeApplicationShutdown(): Promise<void> {
    if (this.stopping.signal.aborted) return;
    this.stopping.abort();
    this.detachSignals?.();
    if (this.purgeTimer) clearTimeout(this.purgeTimer);
    const grace = this.config.get('WORKER_SHUTDOWN_GRACE_MS', { infer: true });
    const finished = await Promise.race([
      Promise.allSettled(this.loops).then(() => true),
      delay(grace, false, { ref: false }),
    ]);
    if (!finished) {
      this.cancel.abort();
      await Promise.allSettled(this.loops);
    }
    await this.purging;
    this.loops = [];
  }

  private async pause(ms: number): Promise<void> {
    try {
      await delay(ms, undefined, { signal: this.stopping.signal });
    } catch {
      // Завершення: виходимо з паузи одразу.
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopping.signal.aborted) {
      const claimed = await this.deliverNext();
      if (!claimed) {
        const poll =
          this.config.get('OUTBOX_POLL_INTERVAL_MS', { infer: true }) *
          (0.5 + Math.random());
        const backoff = this.claimRetryAt - Date.now();
        // Відступ після збою захоплення — для всіх циклів; інакше опитує лише черговий.
        if (this.claimFailures > 0 && backoff > 0)
          await this.pause(Math.max(poll, backoff));
        else
          await this.idleLoops.idle(poll, () =>
            this.system.nextDueWork().then(
              (due) => due.outboxMs,
              (err: unknown) => {
                // Без строку черговий чекає звичайний інтервал опитування.
                this.logger.warn(
                  { error: toSafeError(err) },
                  'next due notification lookup failed',
                );
                return null;
              },
            ),
          );
      }
    }
  }

  /** Одна спроба: захоплення й доставка. false — надсилати зараз нічого (або БД недоступна). */
  async deliverNext(): Promise<boolean> {
    if (this.claimFailures > 0 && Date.now() < this.claimRetryAt) return false;
    let claimed: ClaimedEvent | null;
    try {
      const result = await this.system.claimOutboxEvent(
        this.senderId,
        this.leaseMs,
        this.config.get('OUTBOX_TENANT_IN_FLIGHT', { infer: true }),
      );
      if (result.repaired > 0) this.metrics.dueRepairs.inc(result.repaired);
      claimed = result.event;
      if (this.claimFailures > 0) {
        this.logger.log(
          { consecutiveFailures: this.claimFailures },
          'notification claim recovered',
        );
        this.claimFailures = 0;
      }
    } catch (err) {
      this.metrics.claimFailures.inc();
      if (Date.now() >= this.claimRetryAt) {
        this.claimFailures += 1;
        const retryInMs = backoffMs(this.claimFailures, CLAIM_BACKOFF);
        this.claimRetryAt = Date.now() + retryInMs;
        this.logger.error(
          {
            error: toSafeError(err),
            consecutiveFailures: this.claimFailures,
            retryInMs,
          },
          'notification claim failed',
        );
      }
      return false;
    }
    if (!claimed) return false;
    // Подію отримано: наступний цикл перевірить, чи є ще (ланцюгове пробудження).
    this.idleLoops.worked();
    const run = this.deliver(claimed);
    this.active.add(run);
    try {
      await run;
    } finally {
      this.active.delete(run);
    }
    return true;
  }

  /** Спроба в кореляційному контексті трасування, що завершило виконання. */
  private deliver(claimed: ClaimedEvent): Promise<void> {
    return runWithCorrelationId(
      claimed.correlationId ?? newCorrelationId(),
      'outbox',
      async () => {
        try {
          await this.attempt(claimed);
        } catch (err) {
          // БД недоступна посеред спроби: подію поверне спливання lease (той самий ID і байти).
          this.logger.error(
            {
              eventId: claimed.id,
              attempt: claimed.attempt,
              error: toSafeError(err),
            },
            'notification attempt could not be recorded, it will be retried after its lease expires',
          );
        }
      },
    );
  }

  private async attempt(claimed: ClaimedEvent): Promise<void> {
    const started = performance.now();
    const ctx = await this.begin(claimed);
    if (!ctx) {
      // Lease уже забрали (наприклад, відправник завис довше за lease): нічого не надсилаємо.
      this.metrics.observeAttempt('stale', started);
      return;
    }
    if (!ctx.url || !ctx.enabled || !ctx.secret) {
      // Налаштування вимкнули чи видалили після захоплення: подія чекає, спроби немає.
      await this.finish(claimed, 'paused', started, null, 0);
      return;
    }
    const body = Buffer.from(ctx.payload, 'utf8');
    const timestamp = Math.floor(ctx.now);
    const secrets = [ctx.secret, ...(ctx.nextSecret ? [ctx.nextSecret] : [])];
    const headers = new Headers({
      'content-type': 'application/json',
      'user-agent': 'FlowForge-Notifications/1',
      [EVENT_ID_HEADER]: claimed.id,
      [TIMESTAMP_HEADER]: String(timestamp),
      [ATTEMPT_HEADER]: String(claimed.attempt),
      [SIGNATURE_HEADER]: signatureHeader(secrets, claimed.id, timestamp, body),
    });
    let outcome: AttemptOutcome;
    let status: number | null = null;
    let retryAfter: number | undefined;
    try {
      const res = await outboundHttp(
        new URL(ctx.url),
        'POST',
        headers,
        ctx.payload,
        this.cancel.signal,
        {
          redirects: 'reject',
          readBody: false,
          timeoutMs: this.config.get('OUTBOX_HTTP_TIMEOUT_MS', {
            infer: true,
          }),
        },
      );
      status = res.status;
      outcome =
        res.status >= 200 && res.status < 300
          ? 'delivered'
          : res.status >= 300 && res.status < 400
            ? 'redirect'
            : 'http_error';
      retryAfter = parseRetryAfter(res.headers.get('retry-after'));
    } catch (err) {
      outcome = this.classify(err);
    }
    await this.finish(claimed, outcome, started, status, retryAfter);
  }

  private classify(err: unknown): AttemptOutcome {
    if (this.cancel.signal.aborted) return 'aborted';
    if (err instanceof StepError)
      return err.message.includes('not allowed') ? 'denied' : 'network';
    const name = (err as { name?: unknown })?.name;
    const cause = (err as { cause?: { name?: unknown } })?.cause?.name;
    if (name === 'TimeoutError' || cause === 'TimeoutError') return 'timeout';
    return 'network';
  }

  /**
   * Подія (з перевіркою fencing-токена) і налаштування тенанта — разом, у момент спроби: адресат і
   * ключі однієї спроби завжди з одного стану конфігурації. Спроба запам'ятовує ревізію endpoint-а
   * й ID ключів, якими підписано.
   */
  private async begin(claimed: ClaimedEvent): Promise<AttemptContext | null> {
    return this.db.run(claimed.tenantId, async (em) => {
      const [ctx]: AttemptContext[] = await em.query(
        `SELECT e.payload, s.url, s.enabled, s.revision, s."secretKeyId", s.secret,
                s."nextSecretKeyId", s."nextSecret",
                extract(epoch FROM clock_timestamp())::float8 AS now
           FROM outbox_events e
           LEFT JOIN notification_settings s ON s."tenantId" = e."tenantId"
          WHERE e.id = $1 AND e."tenantId" = $2 AND e."leaseToken" = $3 AND e.status = 'sending'`,
        [claimed.id, claimed.tenantId, claimed.leaseToken],
      );
      if (!ctx) return null;
      const keyIds = [ctx.secretKeyId, ctx.nextSecretKeyId].filter(
        (k): k is string => k !== null,
      );
      await em.query(
        `UPDATE outbox_attempts SET revision = $4, "keyIds" = $5::uuid[]
          WHERE "eventId" = $1 AND "tenantId" = $2 AND attempt = $3`,
        [claimed.id, claimed.tenantId, claimed.attempt, ctx.revision, keyIds],
      );
      return ctx;
    });
  }

  /**
   * Результат спроби — лише якщо lease досі наш (той самий токен, стан `sending`): запізніла
   * відповідь відправника, чий lease забрали, не змінює стану події. Свій рядок журналу спроба
   * записує, поки його не закрило повернення lease. Недоставлена подія — знову `pending` з backoff,
   * без ліміту спроб.
   */
  private async finish(
    claimed: ClaimedEvent,
    outcome: AttemptOutcome,
    started: number,
    httpStatus: number | null,
    retryAfterMs: number | undefined,
  ): Promise<void> {
    const delivered = outcome === 'delivered';
    const delaySeconds =
      outcome === 'paused' || outcome === 'aborted'
        ? 0
        : retryDelayMs(
            claimed.attempt,
            {
              baseMs: this.config.get('OUTBOX_BACKOFF_BASE_MS', {
                infer: true,
              }),
              maxMs: this.config.get('OUTBOX_BACKOFF_MAX_MS', { infer: true }),
            },
            retryAfterMs,
          ) / 1000;
    const durationMs = Math.round(performance.now() - started);
    const current = await this.db.run(claimed.tenantId, async (em) => {
      const [row]: Array<{ applied: boolean }> = await em.query(
        'SELECT public.finish_outbox_event($1,$2,$3,$4,$5) AS applied',
        [claimed.id, claimed.leaseToken, delaySeconds, outcome, httpStatus],
      );
      await em.query(
        `UPDATE outbox_attempts
            SET outcome = $4, "httpStatus" = $5, "durationMs" = $6, "finishedAt" = now()
          WHERE "eventId" = $1 AND "tenantId" = $2 AND attempt = $3 AND "finishedAt" IS NULL`,
        [
          claimed.id,
          claimed.tenantId,
          claimed.attempt,
          outcome,
          httpStatus,
          durationMs,
        ],
      );
      return row.applied;
    });
    this.metrics.observeAttempt(current ? outcome : 'stale', started);
    const fields = {
      eventId: claimed.id,
      attempt: claimed.attempt,
      outcome: current ? outcome : 'stale',
      httpStatus,
      durationMs,
    };
    if (delivered && current) this.logger.log(fields, 'notification delivered');
    else if (!current)
      this.logger.warn(
        fields,
        'notification attempt finished after its lease was taken over, result ignored',
      );
    else
      this.logger.warn(
        { ...fields, retryInMs: Math.round(delaySeconds * 1000) },
        'notification not delivered, will retry',
      );
  }

  /** Очищення доставлених подій раз на JOB_CLEANUP_INTERVAL_MS (з відхиленням ±50%). */
  private schedulePurge(): void {
    if (this.stopping.signal.aborted) return;
    const every = this.config.get('JOB_CLEANUP_INTERVAL_MS', { infer: true });
    this.purgeTimer = setTimeout(
      () => {
        this.purging = this.purgeDelivered()
          .then(() => undefined)
          .catch((err: unknown) =>
            this.logger.error(
              { error: toSafeError(err) },
              'delivered notification cleanup failed',
            ),
          )
          .finally(() => {
            this.purging = undefined;
            this.schedulePurge();
          });
      },
      Math.min(MAX_TIMER_MS, every * (0.5 + Math.random())),
    );
  }

  /** Пачками видаляє доставлені й скасовані події після OUTBOX_RETENTION_DAYS. */
  async purgeDelivered(): Promise<number> {
    const days = this.config.get('OUTBOX_RETENTION_DAYS', { infer: true });
    let total = 0;
    while (!this.stopping.signal.aborted) {
      const deleted = await this.system.purgeDeliveredEvents(days, PURGE_BATCH);
      total += deleted;
      if (deleted < PURGE_BATCH) break;
    }
    this.metrics.purged.inc(total);
    if (total > 0)
      this.logger.log(
        { deleted: total, retentionDays: days },
        'deleted delivered notifications past their retention period',
      );
    return total;
  }
}
