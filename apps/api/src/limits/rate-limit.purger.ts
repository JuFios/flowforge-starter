import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { toSafeError } from '../observability/safe-error';
import { SystemDb } from '../tenancy/system-db';

/** Як часто API видаляє відра частоти запитів, чиє вікно скінчилось (з відхиленням ±50%). */
const PURGE_INTERVAL_MS = 60_000;
/** Скільки відер видаляє одна транзакція. */
const PURGE_BATCH = 1_000;

/**
 * Очищення `rate_limit_buckets`: без нього таблиця росла б із кожним новим тенантом і IP. Пачками
 * (кожна — окрема коротка транзакція, SKIP LOCKED), доки пачка неповна. Помилка не зупиняє API —
 * наступний прохід повторить.
 */
@Injectable()
export class RateLimitPurger
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(RateLimitPurger.name);
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private running?: Promise<void>;

  constructor(private readonly system: SystemDb) {}

  onApplicationBootstrap(): void {
    this.schedule();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(
      () => {
        this.running = this.purge()
          .then(
            () => undefined,
            (err: unknown) =>
              this.logger.error(
                { error: toSafeError(err) },
                'rate limit purge failed',
              ),
          )
          .finally(() => this.schedule());
      },
      PURGE_INTERVAL_MS * (0.5 + Math.random()),
    );
    this.timer.unref();
  }

  /** Один прохід очищення; кількість видалених відер. */
  async purge(): Promise<number> {
    let total = 0;
    while (!this.stopped) {
      const deleted = await this.system.purgeRateLimits(PURGE_BATCH);
      total += deleted;
      if (deleted < PURGE_BATCH) break;
    }
    return total;
  }
}
