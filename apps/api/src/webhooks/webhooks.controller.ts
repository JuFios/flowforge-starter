import {
  BadRequestException,
  UnsupportedMediaTypeException,
  Controller,
  HttpCode,
  Post,
  Req,
} from '@nestjs/common';
import { ExecutionsService } from '../executions/executions.service';
import { parseRunInput } from '../executions/run-input.pipe';
import { RateLimit } from '../limits/rate-limit.guard';
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
    const type = req.headers['content-type'] ?? '';
    if (
      !/^application\/json(?:\s*;\s*charset\s*=\s*(?:"utf-8"|utf-8))?$/i.test(
        type,
      )
    )
      throw new UnsupportedMediaTypeException();
    let body: unknown = {};
    if (Buffer.isBuffer(req.body) && req.body.length) {
      try {
        body = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(req.body),
        ) as unknown;
      } catch {
        throw new BadRequestException('Невалідний UTF-8 JSON');
      }
    }
    if (body === null)
      throw new BadRequestException(
        "Вхідні дані виконання мають бути JSON-об'єктом",
      );
    return {
      executionId: await this.executions.enqueueWebhook(
        req.webhookWorkflow,
        parseRunInput(body),
        req.delivery,
      ),
    };
  }
}
