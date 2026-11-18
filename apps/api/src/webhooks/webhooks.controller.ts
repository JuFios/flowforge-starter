import {
  Body,
  Controller,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac } from 'crypto';
import { Tenant, Workflow } from '../entities';
import { ExecutionsService } from '../executions/executions.service';
import { parseRunInput } from '../executions/run-input.pipe';
import { SystemDb } from '../tenancy/system-db';
import { TenantDb } from '../tenancy/tenant-db';

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
 * Вхідні webhook-и. Підпис: hex HMAC-SHA256 від тіла запиту
 * секретом тенанта, у заголовку x-signature.
 */
@Controller('hooks')
export class WebhooksController {
  constructor(
    private readonly system: SystemDb,
    private readonly db: TenantDb,
    private readonly executions: ExecutionsService,
  ) {}

  @Post(':workflowId')
  @HttpCode(202)
  async receive(
    @Param('workflowId', ParseUUIDPipe) workflowId: string,
    // Без пайпа: вхід перевіряється лише після підпису, інакше неавтентифікований запит
    // отримав би 400 з поясненням формату замість 401.
    @Body() body: unknown,
    @Headers('x-signature') signature?: string,
  ) {
    // Тенант адресата — вузькою SECURITY DEFINER-функцією; workflow і секрет читаються вже в
    // контексті цього тенанта (RLS), з явним предикатом tenantId.
    const tenantId = await this.system.webhookTenant(workflowId);
    const target =
      tenantId &&
      (await this.db.run(tenantId, async (em) => {
        const workflow = await em.findOne(Workflow, {
          where: { id: workflowId, tenantId, enabled: true },
        });
        const tenant = await em.findOne(Tenant, { where: { id: tenantId } });
        return workflow && tenant ? { workflow, tenant } : null;
      }));
    if (!target) throw new NotFoundException();
    const { workflow, tenant } = target;

    const expected = expectedSignature(tenant.webhookSecret, body);
    if (expected === undefined || signature !== expected) {
      throw new UnauthorizedException('Невірний підпис');
    }

    const input = parseRunInput(body);
    const execution = await this.executions.enqueue(workflow, input, 'webhook');
    return { executionId: execution.id };
  }
}
