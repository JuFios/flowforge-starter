import { Controller, HttpCode, Post, Req } from '@nestjs/common';
import {
  ExecutionsService,
  type WebhookAccepted,
} from '../executions/executions.service';
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
  receive(@Req() req: WebhookRequest): Promise<WebhookAccepted> {
    return this.executions.enqueueWebhook(
      req.webhookWorkflow,
      () => parseWebhookBody(req),
      req.delivery,
    );
  }
}
