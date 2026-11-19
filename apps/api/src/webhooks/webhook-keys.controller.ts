import {
  ConflictException,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { Tenant } from '../entities';
import { RateLimit } from '../limits/rate-limit.guard';
import { TenantDb } from '../tenancy/tenant-db';
import type { EntityManager } from 'typeorm';

interface KeyIds {
  webhookKeyId: string;
  nextWebhookKeyId: string | null;
}

@Controller('tenants/me/webhook-secrets')
@RateLimit('tenant', { before: [ApiKeyGuard] })
export class WebhookKeysController {
  constructor(private readonly db: TenantDb) {}
  private async keys(
    em: EntityManager,
    id: string,
    lock: boolean,
  ): Promise<KeyIds> {
    const [row]: KeyIds[] = await em.query(
      'SELECT "webhookKeyId","nextWebhookKeyId" FROM tenants WHERE id=$1' +
        (lock ? ' FOR UPDATE' : ''),
      [id],
    );
    return row;
  }
  @Get()
  async list(@CurrentTenant() tenant: Tenant) {
    return this.db.run(tenant.id, async (em) => {
      const keys = await this.keys(em, tenant.id, false);
      return [keys.webhookKeyId, keys.nextWebhookKeyId]
        .filter((id) => id !== null)
        .map((id) => ({ id }));
    });
  }
  @Post()
  @Header('Cache-Control', 'no-store')
  async rotate(@CurrentTenant() tenant: Tenant) {
    return this.db.run(tenant.id, async (em) => {
      const keys = await this.keys(em, tenant.id, true);
      if (keys.nextWebhookKeyId)
        throw new ConflictException('Уже є два активні ключі');
      const id = randomUUID(),
        secret = randomBytes(24).toString('hex');
      await em.query(
        'UPDATE tenants SET "nextWebhookKeyId"=$2,"nextWebhookSecret"=$3 WHERE id=$1',
        [tenant.id, id, secret],
      );
      return { id, secret };
    });
  }
  @Delete(':keyId')
  @HttpCode(204)
  async revoke(
    @CurrentTenant() tenant: Tenant,
    @Param('keyId', ParseUUIDPipe) rawId: string,
  ) {
    const id = rawId.toLowerCase();
    await this.db.run(tenant.id, async (em) => {
      const keys = await this.keys(em, tenant.id, true);
      if (keys.webhookKeyId === id) {
        if (!keys.nextWebhookKeyId)
          throw new ConflictException('Потрібен хоча б один активний ключ');
        await em.query(
          'UPDATE tenants SET "webhookKeyId"="nextWebhookKeyId","webhookSecret"="nextWebhookSecret","nextWebhookKeyId"=NULL,"nextWebhookSecret"=NULL WHERE id=$1',
          [tenant.id],
        );
      } else if (keys.nextWebhookKeyId === id) {
        await em.query(
          'UPDATE tenants SET "nextWebhookKeyId"=NULL,"nextWebhookSecret"=NULL WHERE id=$1',
          [tenant.id],
        );
      }
    });
  }
}
