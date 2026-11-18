import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { Tenant } from '../entities';
import { SystemDb } from '../tenancy/system-db';
import { TenantDb } from '../tenancy/tenant-db';

export interface TenantRequest {
  headers: Record<string, string | string[] | undefined>;
  tenant: Tenant;
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** Найдовший ключ, який має сенс шукати: видані ключі — `ff_` + 48 hex-символів. */
export const MAX_API_KEY_LENGTH = 256;

/**
 * Автентифікація тенанта за `x-api-key`. Пошук ключа — SECURITY DEFINER-функцією `auth_tenant`
 * (тенант ще невідомий, а RLS без контексту нічого не показує); сам тенант читається вже в його
 * контексті.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly system: SystemDb,
    private readonly db: TenantDb,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<TenantRequest>();
    const key = req.headers['x-api-key'];
    if (typeof key !== 'string' || key.length === 0) {
      throw new UnauthorizedException('Відсутній x-api-key');
    }
    // Завелике значення не може бути виданим ключем: не рахуємо хеш і не йдемо в БД.
    if (key.length > MAX_API_KEY_LENGTH)
      throw new UnauthorizedException('Невірний API-ключ');
    const tenantId = await this.system.authTenant(hashApiKey(key));
    const tenant =
      tenantId &&
      (await this.db.run(tenantId, (em) =>
        em.findOne(Tenant, { where: { id: tenantId } }),
      ));
    if (!tenant) {
      throw new UnauthorizedException('Невірний API-ключ');
    }
    req.tenant = tenant;
    return true;
  }
}
