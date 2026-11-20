import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  Injectable,
  Type,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  normalizeIp,
  SkipThrottle,
  ThrottlerStorage,
  ThrottlerGuard,
  ThrottlerModuleOptions,
  ThrottlerRequest,
} from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { EnvironmentVariables } from '../config/env.validation';
import { Tenant } from '../entities';
import { EffectiveLimits } from '../tenancy/limits';
import { RateLimitedException } from './limit-exceptions';
import { LimitsMetrics } from './limits.metrics';
import { setRateLimitHeaders } from './rate-limit-headers';

/** Імена лімітів частоти (docs/architecture.md, «Контракт лімітів»). */
export const THROTTLERS = [
  'tenant',
  'webhook',
  'admin',
  'session_revoke',
] as const;
export type ThrottlerName = (typeof THROTTLERS)[number];

/** Запит, тенанта й ліміти якого вже встановив guard автентифікації (ключ або підпис). */
export interface LimitedRequest extends Request {
  tenant?: Tenant;
  limits?: EffectiveLimits;
}

function authenticated(context: ExecutionContext): {
  tenant: Tenant;
  limits: EffectiveLimits;
} {
  const req = context.switchToHttp().getRequest<LimitedRequest>();
  // Ліміт тенанта стоїть після guard-а автентифікації (RateLimit): інакше — помилка програміста.
  if (!req.tenant || !req.limits)
    throw new Error('tenant rate limit requires an authenticated tenant');
  return { tenant: req.tenant, limits: req.limits };
}

/** IP клієнта (з урахуванням TRUST_PROXY), IPv6 — підмережею /64, як у throttler-а. */
export function clientIp(req: Request): string {
  return normalizeIp(req.ip ?? req.socket.remoteAddress ?? 'unknown');
}

/**
 * Налаштування лімітів частоти: `tenant` (API з ключем) і `webhook` — окремі квоти тенанта з його
 * ефективних лімітів; `admin` — за IP, з конфігурації.
 */
export function throttlerOptions(
  config: ConfigService<EnvironmentVariables, true>,
): ThrottlerModuleOptions {
  return {
    throttlers: [
      {
        name: 'tenant',
        limit: (ctx) => authenticated(ctx).limits.rateLimit,
        ttl: (ctx) => authenticated(ctx).limits.rateWindowMs,
        getTracker: (_req, ctx) => authenticated(ctx).tenant.id,
      },
      {
        name: 'webhook',
        limit: (ctx) => authenticated(ctx).limits.webhookRateLimit,
        ttl: (ctx) => authenticated(ctx).limits.webhookRateWindowMs,
        getTracker: (_req, ctx) => authenticated(ctx).tenant.id,
      },
      {
        name: 'admin',
        limit: config.get('ADMIN_RATE_LIMIT', { infer: true }),
        ttl: config.get('ADMIN_RATE_WINDOW_MS', { infer: true }),
        getTracker: (req) => clientIp(req as Request),
      },
      {
        name: 'session_revoke',
        limit: 60,
        ttl: 60_000,
        getTracker: (_req, ctx) => authenticated(ctx).tenant.id,
      },
    ],
  };
}

/**
 * Ліміт частоти запитів (`@nestjs/throttler`, сховище — Postgres). Від стандартного guard-а
 * відрізняється:
 * - ключ — `<ліміт>:<тенант або IP>` без імені обробника: одна квота на всі маршрути тенанта;
 * - заголовки `X-RateLimit-*` без суфікса імені ліміту (на маршруті діє рівно один) і тіло 429
 *   `rate_limited` у форматі помилок API.
 */
@Injectable()
export class RateLimitGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
    private readonly metrics: LimitsMetrics,
  ) {
    super(options, storage, reflector);
  }

  protected override generateKey(
    _context: ExecutionContext,
    tracker: string,
    name: string,
  ): string {
    return `${name}:${tracker}`;
  }

  protected override async handleRequest({
    context,
    limit,
    ttl,
    throttler,
    getTracker,
    generateKey,
  }: ThrottlerRequest): Promise<boolean> {
    const { req, res } = this.getRequestResponse(context);
    const name = throttler.name ?? 'default';
    const tracker = await getTracker(req, context);
    const record = await this.storageService.increment(
      generateKey(context, tracker, name),
      ttl,
      limit,
      ttl,
      name,
    );
    setRateLimitHeaders(res as { setHeader(n: string, v: number): void }, {
      limit,
      hits: record.totalHits,
      resetMs: record.timeToExpire * 1000,
    });
    if (record.isBlocked) {
      this.metrics.rateLimited.inc({ throttler: name });
      throw new RateLimitedException(record.timeToExpire);
    }
    return true;
  }
}

/**
 * Маршрут під лімітом `name`: guard-и `before` (автентифікація встановлює тенанта й ліміти), далі
 * ліміт частоти, далі `after`. Решта лімітів на маршруті не діє.
 */
export function RateLimit(
  name: ThrottlerName,
  {
    before = [],
    after = [],
  }: {
    before?: Array<Type<CanActivate>>;
    after?: Array<Type<CanActivate>>;
  } = {},
): ClassDecorator & MethodDecorator {
  return applyDecorators(
    SkipThrottle(
      Object.fromEntries(THROTTLERS.map((other) => [other, other !== name])),
    ),
    UseGuards(...before, RateLimitGuard, ...after),
  );
}
