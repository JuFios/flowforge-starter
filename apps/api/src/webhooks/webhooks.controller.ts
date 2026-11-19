import { Controller, HttpCode, Post, Req } from '@nestjs/common';
import { ExecutionsService } from '../executions/executions.service';
import { RateLimit } from '../limits/rate-limit.guard';
import { parseWebhookBody } from './webhook-body';
import {
  WebhookRequest,
  WebhookSignatureGuard,
} from './webhook-signature.guard';

@Controller('hooks')
@RateLimit('webhook', { before: [WebhookSignatureGuard] })
export class WebhooksController {
  constructor(private readonly executions: ExecutionsService) {}

  @Post(':workflowId')
  @HttpCode(202)
  async receive(@Req() req: WebhookRequest) {
    return {
      executionId: await this.executions.enqueueWebhook(
        req.webhookWorkflow,
        parseWebhookBody(req),
        req.delivery,
      ),
    };
  }
}
