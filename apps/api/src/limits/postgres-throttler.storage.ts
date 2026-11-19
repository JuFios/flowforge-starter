import { Injectable } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import { SystemDb } from '../tenancy/system-db';
import { secondsUntilReset } from './rate-limit-headers';

type ThrottlerStorageRecord = Awaited<
  ReturnType<ThrottlerStorage['increment']>
>;

/**
 * Сховище `@nestjs/throttler` у Postgres (документація Nest: власний ThrottlerStorage): фіксоване
 * вікно на ключ, атомарний upsert функцією `rate_limit_hit` за годинником БД — один лічильник на
 * всі інстанси API. Блокування понад ліміт триває до кінця вікна (blockDuration = вікно).
 * Недоступна БД — помилка запиту (5xx), а не мовчазний пропуск ліміту.
 */
@Injectable()
export class PostgresThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly system: SystemDb) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
  ): Promise<ThrottlerStorageRecord> {
    const { hits, resetMs } = await this.system.rateLimitHit(key, ttl, 1);
    const seconds = secondsUntilReset(resetMs);
    return {
      totalHits: hits,
      timeToExpire: seconds,
      isBlocked: hits > limit,
      timeToBlockExpire: seconds,
    };
  }
}
