import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { Tenant } from '../entities';
import { AuthFailureLimiter } from '../limits/auth-failure.limiter';
import { effectiveLimits } from '../limits/effective-limits';
import { EffectiveLimits } from '../tenancy/limits';
import { SystemDb } from '../tenancy/system-db';
import { TenantDb } from '../tenancy/tenant-db';

export interface TenantRequest {
  headers: Record<string, string | string[] | undefined>;
  tenant: Tenant;
  sessionId?: string;
  /** Ефективні ліміти тенанта (для ліміту частоти, що стоїть після автентифікації). */
  limits: EffectiveLimits;
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** Найдовший ключ, який має сенс шукати: видані ключі — `ff_` + 48 hex-символів. */
export const MAX_API_KEY_LENGTH = 256;

/**
 * Автентифікація тенанта за `x-api-key`. Пошук ключа — SECURITY DEFINER-функцією `auth_tenant`
 * (тенант ще невідомий, а RLS без контексту нічого не показує); сам тенант і його ефективні ліміти
 * читаються вже в його контексті. Невдача рахується лімітом невдалих автентифікацій з IP.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  protected readonly credentials: 'api-key' | 'either' | 'session' = 'api-key';
  constructor(
    private readonly system: SystemDb,
    private readonly db: TenantDb,
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
    const session = bearer
      ? await this.system.authSession(
          createHash('sha256').update(bearer).digest(),
        )
      : undefined;
    const tenantId =
      session?.tenantId ??
      (typeof key === 'string' && key.length <= MAX_API_KEY_LENGTH
        ? await this.system.authTenant(hashApiKey(key))
        : null);
    req.sessionId = session?.id;
    const found =
      tenantId &&
      (await this.db.run(tenantId, async (em) => {
        const tenant = await em.findOne(Tenant, {
          where: { id: tenantId },
          select: { id: true },
        });
        return tenant && { tenant, limits: await effectiveLimits(em) };
      }));
    if (!found)
      return this.authFailures.reject(
        ctx,
        new UnauthorizedException(
          sessionOnly ? 'Невірна браузерна сесія' : 'Невірний API-ключ',
        ),
      );
    req.tenant = found.tenant;
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
