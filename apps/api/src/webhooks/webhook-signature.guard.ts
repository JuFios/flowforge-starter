import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac } from 'crypto';
import { isUUID } from 'class-validator';
import type { Request } from 'express';
import { safeEqual } from '../common/safe-equal';
import { Tenant, Workflow } from '../entities';
import { AuthFailureLimiter } from '../limits/auth-failure.limiter';
import { effectiveLimits } from '../limits/effective-limits';
import { EffectiveLimits } from '../tenancy/limits';
import { SystemDb } from '../tenancy/system-db';
import { TenantDb } from '../tenancy/tenant-db';

/** Запит webhook-а з підтвердженим підписом: адресат, його тенант і ефективні ліміти. */
export interface WebhookRequest extends Request {
  tenant: Tenant;
  limits: EffectiveLimits;
  webhookWorkflow: Workflow;
}

/**
 * Очікуваний підпис тіла або undefined, якщо тіло неможливо серіалізувати: на надглибокій
 * вкладеності JSON.stringify переповнює стек (RangeError). Такий підпис не підтверджується —
 * відповідь 401, як і на будь-який непідтверджений запит, а не 500.
 */
function expectedSignature(secret: string, body: unknown): string | undefined {
  let serialized: string;
  try {
    serialized = JSON.stringify(body);
  } catch (err) {
    if (err instanceof RangeError) return undefined;
    throw err;
  }
  return createHmac('sha256', secret).update(serialized).digest('hex');
}

/**
 * Підпис webhook-а: hex HMAC-SHA256 від тіла запиту секретом тенанта (`x-signature`). Guard, а не
 * код обробника, — щоб ліміт частоти webhook-ів (наступний guard) рахувався лише після
 * підтвердженого підпису й на тенанта адресата. Невірний підпис і невідомий адресат рахуються лімітом невдалих
 * автентифікацій з IP. Тіло на цей момент уже розібране (body-parser), але ще не перевірене:
 * неавтентифікований запит отримує 401, а не пояснення формату.
 */
@Injectable()
export class WebhookSignatureGuard implements CanActivate {
  constructor(
    private readonly system: SystemDb,
    private readonly db: TenantDb,
    private readonly authFailures: AuthFailureLimiter,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<WebhookRequest>();
    const workflowId = req.params.workflowId;
    // Як ParseUUIDPipe: guard виконується раніше за пайпи параметрів.
    if (!isUUID(workflowId))
      throw new BadRequestException('Validation failed (uuid is expected)');
    // Тенант адресата — вузькою SECURITY DEFINER-функцією; workflow, секрет і ліміти читаються
    // вже в контексті цього тенанта (RLS), з явним предикатом tenantId.
    const tenantId = await this.system.webhookTenant(workflowId);
    const target =
      tenantId &&
      (await this.db.run(tenantId, async (em) => {
        const workflow = await em.findOne(Workflow, {
          where: { id: workflowId, tenantId, enabled: true },
        });
        const tenant = await em.findOne(Tenant, { where: { id: tenantId } });
        return workflow && tenant
          ? { workflow, tenant, limits: await effectiveLimits(em) }
          : null;
      }));
    // Невідомий чи вимкнений адресат — теж невдала автентифікація (ліміт за IP): інакше перебір
    // випадкових UUID без жодного ліміту навантажував би БД пошуком тенанта.
    if (!target) return this.authFailures.reject(ctx, new NotFoundException());

    const expected = expectedSignature(target.tenant.webhookSecret, req.body);
    if (
      expected === undefined ||
      !safeEqual(req.headers['x-signature'], expected)
    )
      return this.authFailures.reject(
        ctx,
        new UnauthorizedException('Невірний підпис'),
      );
    req.tenant = target.tenant;
    req.limits = target.limits;
    req.webhookWorkflow = target.workflow;
    return true;
  }
}
