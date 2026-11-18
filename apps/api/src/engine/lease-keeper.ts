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
 *   воркер уже може забрати задачу. Цей дедлайн — окремий таймер: він спрацьовує, навіть якщо
 *   запит продовження завис (його межа — query_timeout, довша за lease) і досі не повернувся.
 */
export class LeaseKeeper {
  /** Частка lease, яку лишаємо запасом на розбіжність годинників і затримку мережі. */
  private static readonly SAFETY = 0.2;

  private readonly logger = new Logger(LeaseKeeper.name);
  private readonly controller = new AbortController();
  private timer?: NodeJS.Timeout;
  private deadline?: NodeJS.Timeout;
  private validUntil: number;
  private stopped = false;

  constructor(
    private readonly queue: JobQueueService,
    private readonly job: Job,
    private readonly leaseMs: number,
    leaseStartedAt: number,
  ) {
    this.validUntil = leaseStartedAt + leaseMs;
  }

  /** Скасовується, коли lease втрачено (або зупинку запросив воркер, див. `abort`). */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  start(): this {
    this.armDeadline();
    const firstRenewal = this.validUntil - (2 * this.leaseMs) / 3;
    this.schedule(Math.max(0, firstRenewal - performance.now()));
    return this;
  }

  /** Скасувати роботу над задачею з причиною (напр., завершення воркера). */
  abort(reason: Error): void {
    if (!this.controller.signal.aborted) this.controller.abort(reason);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.deadline);
  }

  /** Скасувати роботу, коли до кінця відомого lease лишається частка SAFETY. */
  private armDeadline(): void {
    clearTimeout(this.deadline);
    const remaining = this.safeTimeRemaining();
    if (remaining <= 0) {
      this.expire();
      return;
    }
    this.deadline = setTimeout(() => this.expire(), Math.ceil(remaining));
  }

  private safeTimeRemaining(): number {
    return (
      this.validUntil - this.leaseMs * LeaseKeeper.SAFETY - performance.now()
    );
  }

  private expire(): void {
    if (this.stopped || this.signal.aborted) return;
    this.logger.warn(
      { jobId: this.job.id, executionId: this.job.executionId },
      'lease could not be renewed in time, abandoning job',
    );
    this.abort(new Error('lease could not be renewed'));
  }

  /** Перевіряємо час перед ефектом і після SQL, навіть якщо цикл подій затримав таймер. */
  assertActive(): void {
    if (this.safeTimeRemaining() <= 0) this.expire();
    this.signal.throwIfAborted();
  }

  private schedule(delayMs = this.leaseMs / 3): void {
    if (this.stopped || this.controller.signal.aborted) return;
    this.timer = setTimeout(() => void this.renew(), delayMs);
  }

  private async renew(): Promise<void> {
    if (this.stopped) return;
    const startedAt = performance.now();
    try {
      const renewed = await this.queue.heartbeat(this.job);
      if (this.stopped || this.signal.aborted) return;
      if (renewed) {
        // БД продовжила lease від моменту, не ранішого за надсилання запиту: рахуємо від
        // надсилання — із запасом.
        this.validUntil = startedAt + this.leaseMs;
        this.armDeadline();
      } else {
        this.logger.warn(
          { jobId: this.job.id, executionId: this.job.executionId },
          'lease lost: job was taken over, abandoning it',
        );
        this.abort(new Error('lease lost'));
        return;
      }
    } catch (err) {
      // Спроби тривають; якщо lease от-от мине, роботу зупинить дедлайн (armDeadline).
      this.logger.warn(
        { jobId: this.job.id, error: toSafeError(err) },
        'lease renewal failed, retrying',
      );
    }
    this.schedule();
  }
}
