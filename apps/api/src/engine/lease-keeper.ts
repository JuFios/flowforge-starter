import { Logger } from '@nestjs/common';
import { Job } from '../entities';
import { toSafeError } from '../observability/safe-error';
import { JobQueueService } from './job-queue.service';

/**
 * Тримає lease задачі, поки воркер над нею працює: продовжує його кожну третину тривалості.
 *
 * - Продовження змінило 0 рядків — lease забрано (reaper повернув задачу або її захопив інший
 *   воркер): `signal` скасовується негайно, поточний крок переривається, записів далі не буде.
 * - Тимчасова помилка БД — не привід кидати роботу: спроби тривають, але якщо lease за
 *   годинником воркера от-от мине (лишилась частка `SAFETY`), `signal` скасовується, бо інший
 *   воркер уже може забрати задачу.
 */
export class LeaseKeeper {
  /** Частка lease, яку лишаємо запасом на розбіжність годинників і затримку мережі. */
  private static readonly SAFETY = 0.2;

  private readonly logger = new Logger(LeaseKeeper.name);
  private readonly controller = new AbortController();
  private timer?: NodeJS.Timeout;
  private validUntil: number;
  private stopped = false;

  constructor(
    private readonly queue: JobQueueService,
    private readonly job: Job,
    private readonly leaseMs: number,
  ) {
    this.validUntil = Date.now() + leaseMs;
  }

  /** Скасовується, коли lease втрачено (або зупинку запросив воркер, див. `abort`). */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  start(): this {
    this.schedule();
    return this;
  }

  /** Скасувати роботу над задачею з причиною (напр., завершення воркера). */
  abort(reason: Error): void {
    if (!this.controller.signal.aborted) this.controller.abort(reason);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.renew(), this.leaseMs / 3);
  }

  private async renew(): Promise<void> {
    if (this.stopped) return;
    const startedAt = Date.now();
    try {
      if (await this.queue.heartbeat(this.job)) {
        this.validUntil = startedAt + this.leaseMs;
      } else {
        this.logger.warn(
          { jobId: this.job.id, executionId: this.job.executionId },
          'lease lost: job was taken over, abandoning it',
        );
        this.abort(new Error('lease lost'));
        return;
      }
    } catch (err) {
      this.logger.warn(
        { jobId: this.job.id, error: toSafeError(err) },
        'lease renewal failed, retrying',
      );
      if (Date.now() > this.validUntil - this.leaseMs * LeaseKeeper.SAFETY) {
        this.logger.warn(
          { jobId: this.job.id, executionId: this.job.executionId },
          'lease could not be renewed in time, abandoning job',
        );
        this.abort(new Error('lease could not be renewed'));
        return;
      }
    }
    this.schedule();
  }
}
