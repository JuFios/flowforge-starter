import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  KeyRow,
  readClock,
  VerifiedDelivery,
  verifyDelivery,
} from './webhook-signature';
import { isUUID } from 'class-validator';
import type { Request } from 'express';
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
  delivery: VerifiedDelivery;
}

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
        if (!workflow) return null;
        const tenant = await em.findOneOrFail(Tenant, {
          where: { id: tenantId },
          select: { id: true },
        });
        const [keys]: KeyRow[] = await em.query(
          'SELECT "webhookKeyId","webhookSecret","nextWebhookKeyId","nextWebhookSecret" FROM tenants WHERE id=$1',
          [tenantId],
        );
        const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const delivery = verifyDelivery(
          req,
          workflowId,
          bytes,
          keys,
          await readClock(em),
        );
        return {
          workflow,
          tenant,
          delivery,
          limits: delivery ? await effectiveLimits(em) : undefined,
        };
      }));
    // Невідомий чи вимкнений адресат — теж невдала автентифікація (ліміт за IP): інакше перебір
    // випадкових UUID без жодного ліміту навантажував би БД пошуком тенанта.
    if (!target) return this.authFailures.reject(ctx, new NotFoundException());

    if (!target.delivery || !target.limits)
      return this.authFailures.reject(
        ctx,
        new UnauthorizedException('Невірний підпис'),
      );
    req.delivery = target.delivery;
    req.tenant = target.tenant;
    req.limits = target.limits;
    req.webhookWorkflow = target.workflow;
    return true;
  }
}
