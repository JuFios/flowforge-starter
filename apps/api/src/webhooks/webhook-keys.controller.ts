import {
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { CurrentTenant } from '../auth/current-tenant.decorator';
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

  @Post()
  @Header('Cache-Control', 'no-store')
  rotate(@CurrentTenant() tenant: Tenant) {
    return this.keys.rotate(tenant.id);
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
