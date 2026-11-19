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
  constructor(
    private readonly system: SystemDb,
    private readonly db: TenantDb,
    private readonly authFailures: AuthFailureLimiter,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<TenantRequest>();
    const key = req.headers['x-api-key'];
    if (typeof key !== 'string' || key.length === 0)
      return this.authFailures.reject(
        ctx,
        new UnauthorizedException('Відсутній x-api-key'),
      );
    // Завелике значення не може бути виданим ключем: не рахуємо хеш і не шукаємо його.
    const tenantId =
      key.length > MAX_API_KEY_LENGTH
        ? null
        : await this.system.authTenant(hashApiKey(key));
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
        new UnauthorizedException('Невірний API-ключ'),
      );
    req.tenant = found.tenant;
    req.limits = found.limits;
    return true;
  }
}
