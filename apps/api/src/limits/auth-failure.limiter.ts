import { ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { EnvironmentVariables } from '../config/env.validation';
import { SystemDb } from '../tenancy/system-db';
import { RateLimitedException } from './limit-exceptions';
import { LimitsMetrics } from './limits.metrics';
import { secondsUntilReset, setRateLimitHeaders } from './rate-limit-headers';
import { clientIp } from './rate-limit.guard';

/**
 * Ліміт невдалих автентифікацій з однієї IP-адреси (невірний API-ключ, невірний підпис
 * webhook-а): кожна невдача рахується, понад AUTH_FAILURE_RATE_LIMIT за вікно — 429 замість 401.
 * Успішні запити не рахуються й не обмежуються цим лімітом.
 */
@Injectable()
export class AuthFailureLimiter {
  constructor(
    private readonly system: SystemDb,
    private readonly config: ConfigService<EnvironmentVariables, true>,
    private readonly metrics: LimitsMetrics,
  ) {}

  /** Рахує невдачу й кидає `rejection` (401) або, понад ліміт, 429 `rate_limited`. */
  async reject(
    context: ExecutionContext,
    rejection: HttpException,
  ): Promise<never> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const limit = this.config.get('AUTH_FAILURE_RATE_LIMIT', { infer: true });
    const { hits, resetMs } = await this.system.rateLimitHit(
      `auth-failures:${clientIp(req)}`,
      this.config.get('AUTH_FAILURE_RATE_WINDOW_MS', { infer: true }),
      1,
    );
    setRateLimitHeaders(res, { limit, hits, resetMs });
    if (hits > limit) {
      this.metrics.rateLimited.inc({ throttler: 'auth-failures' });
      throw new RateLimitedException(secondsUntilReset(resetMs));
    }
    throw rejection;
  }
}
