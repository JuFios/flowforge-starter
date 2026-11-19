import { Controller, HttpCode, Post, Req } from '@nestjs/common';
import { ExecutionsService } from '../executions/executions.service';
import { parseRunInput } from '../executions/run-input.pipe';
import { RateLimit } from '../limits/rate-limit.guard';
import {
  WebhookRequest,
  WebhookSignatureGuard,
} from './webhook-signature.guard';

/**
 * Вхідні webhook-и. Підпис: hex HMAC-SHA256 від тіла запиту секретом тенанта, у заголовку
 * x-signature (WebhookSignatureGuard); далі — ліміт частоти webhook-ів тенанта (окрема квота від
 * API) і ліміт його черги.
 */
@Controller('hooks')
@RateLimit('webhook', { before: [WebhookSignatureGuard] })
export class WebhooksController {
  constructor(private readonly executions: ExecutionsService) {}

  @Post(':workflowId')
  @HttpCode(202)
  async receive(@Req() req: WebhookRequest) {
    // Вхід перевіряється лише після підпису (guard), інакше неавтентифікований запит отримав би
    // 400 з поясненням формату замість 401.
    const input = parseRunInput(req.body);
    const execution = await this.executions.enqueue(
      req.webhookWorkflow,
      input,
      'webhook',
    );
    return { executionId: execution.id };
  }
}
