import {
  Body,
  Controller,
  ForbiddenException,
  Headers,
  Post,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { IsStorableText } from '../common/storable-text';
import { hashApiKey } from '../auth/api-key.guard';
import { EnvironmentVariables } from '../config/env.validation';
import { Tenant } from '../entities';
import { TenantDb } from '../tenancy/tenant-db';

class CreateTenantDto {
  @IsString()
  @IsStorableText()
  @MinLength(2)
  @MaxLength(200)
  name: string;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

@Controller('tenants')
export class TenantsController {
  constructor(
    private readonly db: TenantDb,
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {}

  /** Службовий ендпоінт створення тенанта (захищений ADMIN_TOKEN). */
  @Post()
  async create(
    @Body() dto: CreateTenantDto,
    @Headers('x-admin-token') admin?: string,
  ) {
    const expected = this.config.get('ADMIN_TOKEN', { infer: true });
    if (!expected || !admin || !safeEqual(admin, expected)) {
      throw new ForbiddenException();
    }
    const apiKey = `ff_${randomBytes(24).toString('hex')}`;
    const webhookSecret = randomBytes(24).toString('hex');
    // Під RLS рядок тенанта видно й можна вставити лише в його власному контексті, тож id
    // генерується тут, до вставки.
    const id = randomUUID();
    const tenant = await this.db.run(id, (em) =>
      em.save(
        em.create(Tenant, {
          id,
          name: dto.name,
          apiKeyHash: hashApiKey(apiKey),
          webhookSecret,
        }),
      ),
    );
    return { id: tenant.id, name: tenant.name, apiKey, webhookSecret };
  }
}
