import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { SigningSecretDto } from '../common/key-material';
import { Tenant } from '../entities';
import { RateLimit } from '../limits/rate-limit.guard';
import { WebhookKeysService } from './webhook-keys.service';

@Controller('tenants/me/webhook-secrets')
@RateLimit('tenant', { before: [ApiKeyGuard] })
export class WebhookKeysController {
  constructor(private readonly keys: WebhookKeysService) {}

  @Get()
  list(@CurrentTenant() tenant: Tenant) {
    return this.keys.list(tenant.id);
  }

  /** Новий ключ `next` із секретом клієнта (201); повтор того самого секрету — 200 з тим самим ID. */
  @Post()
  @Header('Cache-Control', 'no-store')
  async rotate(
    @CurrentTenant() tenant: Tenant,
    @Body() body: SigningSecretDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { id, role, created } = await this.keys.rotate(
      tenant.id,
      body.secret,
    );
    if (!created) res.status(200);
    return { id, role };
  }

  @Delete(':keyId')
  @HttpCode(204)
  async revoke(
    @CurrentTenant() tenant: Tenant,
    @Param('keyId', ParseUUIDPipe) keyId: string,
  ): Promise<void> {
    await this.keys.revoke(tenant.id, keyId);
  }
}
