import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { Tenant } from '../entities';
import { AuthFailureLimiter } from '../limits/auth-failure.limiter';
import { EffectiveLimits } from '../tenancy/limits';
import { SystemDb } from '../tenancy/system-db';

export interface TenantRequest {
  headers: Record<string, string | string[] | undefined>;
  tenant: Tenant;
  sessionId?: string;
  /** Ефективні ліміти тенанта (для ліміту частоти, що стоїть після автентифікації). */
  limits: EffectiveLimits;
}

/** Лише ефективні ліміти з рядка автентифікації (без ідентифікаторів і строку сесії). */
function limitsOf(row: EffectiveLimits): EffectiveLimits {
  return {
    maxRunning: row.maxRunning,
    maxQueueSize: row.maxQueueSize,
    rateLimit: row.rateLimit,
    rateWindowMs: row.rateWindowMs,
    webhookRateLimit: row.webhookRateLimit,
    webhookRateWindowMs: row.webhookRateWindowMs,
    maxWorkflows: row.maxWorkflows,
    maxOutboxEvents: row.maxOutboxEvents,
  };
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** Найдовший ключ, який має сенс шукати: видані ключі — `ff_` + 48 hex-символів. */
export const MAX_API_KEY_LENGTH = 256;

/**
 * Автентифікація тенанта за `x-api-key` або браузерною сесією. Пошук — SECURITY DEFINER-функціями
 * `auth_tenant` / `auth_session` (тенант ще невідомий, а RLS без контексту нічого не показує); вони
 * ж повертають ефективні ліміти тенанта тим самим виразом, що й `tenant_limits()`. Невдача рахується лімітом невдалих автентифікацій з IP.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  protected readonly credentials: 'api-key' | 'either' | 'session' = 'api-key';
  constructor(
    private readonly system: SystemDb,
    private readonly authFailures: AuthFailureLimiter,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<TenantRequest>();
    const sessionOnly = this.credentials === 'session';
    const key = sessionOnly ? undefined : req.headers['x-api-key'];
    const authorization = req.headers.authorization;
    const bearer =
      this.credentials !== 'api-key' &&
      key === undefined &&
      typeof authorization === 'string' &&
      /^Bearer ffs_[0-9a-f]{64}$/.test(authorization)
        ? authorization.slice(7)
        : undefined;
    if (!bearer && (typeof key !== 'string' || key.length === 0))
      return this.authFailures.reject(
        ctx,
        new UnauthorizedException(
          sessionOnly ? 'Потрібна браузерна сесія' : 'Відсутній x-api-key',
        ),
      );
    // Завелике значення не може бути виданим ключем: не рахуємо хеш і не шукаємо його.
    // Тенант і його ефективні ліміти — одним викликом SECURITY DEFINER-функції, без окремої
    // транзакції тенанта (docs/architecture.md, «Автентифікація запиту»).
    const session = bearer
      ? await this.system.authSession(
          createHash('sha256').update(bearer).digest(),
        )
      : undefined;
    const byKey =
      !bearer && typeof key === 'string' && key.length <= MAX_API_KEY_LENGTH
        ? await this.system.authTenant(hashApiKey(key))
        : null;
    req.sessionId = session?.id;
    const found = session
      ? { tenantId: session.tenantId, limits: limitsOf(session) }
      : byKey && { tenantId: byKey.id, limits: limitsOf(byKey) };
    if (!found)
      return this.authFailures.reject(
        ctx,
        new UnauthorizedException(
          sessionOnly ? 'Невірна браузерна сесія' : 'Невірний API-ключ',
        ),
      );
    req.tenant = Object.assign(new Tenant(), { id: found.tenantId });
    req.limits = found.limits;
    return true;
  }
}

/** Доступ браузера лише до маршрутів workflow і виконань. */
@Injectable()
export class TenantAuthGuard extends ApiKeyGuard {
  protected readonly credentials = 'either';
}

/** Відкликання потребує ідентифікованої сесії до перевірки квоти. */
@Injectable()
export class BrowserSessionGuard extends ApiKeyGuard {
  protected readonly credentials = 'session';
}
