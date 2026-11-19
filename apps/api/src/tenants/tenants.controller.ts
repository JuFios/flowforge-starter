import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { randomBytes, randomUUID } from 'crypto';
import {
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { EntityManager } from 'typeorm';
import { hashApiKey } from '../auth/api-key.guard';
import { IsStorableText } from '../common/storable-text';
import { Tenant } from '../entities';
import { effectiveLimits } from '../limits/effective-limits';
import { RateLimit } from '../limits/rate-limit.guard';
import { EffectiveLimits, TenantLimitOverrides } from '../tenancy/limits';
import { TenantDb } from '../tenancy/tenant-db';
import { AdminTokenGuard } from './admin-token.guard';
import { LIMIT_FIELDS, TenantLimitsDto } from './tenant-limits.dto';

class CreateTenantDto {
  @IsString()
  @IsStorableText()
  @MinLength(2)
  @MaxLength(200)
  name: string;

  /** Перевизначення лімітів (необов'язково); без них — значення за замовчуванням. */
  @IsOptional()
  @ValidateNested()
  @Type(() => TenantLimitsDto)
  limits?: TenantLimitsDto;
}

/** Ліміти тенанта у відповіді адмін-API: перевизначення (null — за замовчуванням) і ефективні. */
interface TenantLimitsView {
  overrides: TenantLimitOverrides;
  effective: EffectiveLimits;
}

/** Задані в DTO поля перевизначень (відсутні — без змін, null — скинути). */
function overridesFrom(
  dto: TenantLimitsDto | undefined,
): Partial<TenantLimitOverrides> {
  const result: Partial<TenantLimitOverrides> = {};
  for (const field of LIMIT_FIELDS)
    if (dto?.[field] !== undefined) result[field] = dto[field] ?? null;
  return result;
}

async function limitsView(
  em: EntityManager,
  tenant: Tenant,
): Promise<TenantLimitsView> {
  const overrides = Object.fromEntries(
    LIMIT_FIELDS.map((field) => [field, tenant[field]]),
  ) as unknown as TenantLimitOverrides;
  return { overrides, effective: await effectiveLimits(em) };
}

/**
 * Службові ендпоінти тенантів (ADMIN_TOKEN): створення й ліміти. Кожен запит рахується лімітом
 * `admin` за IP ще до перевірки токена — перебір токена обмежений.
 */
@Controller('tenants')
@RateLimit('admin', { after: [AdminTokenGuard] })
export class TenantsController {
  constructor(private readonly db: TenantDb) {}

  @Post()
  async create(@Body() dto: CreateTenantDto) {
    const apiKey = `ff_${randomBytes(24).toString('hex')}`;
    const webhookSecret = randomBytes(24).toString('hex');
    // Під RLS рядок тенанта видно й можна вставити лише в його власному контексті, тож id
    // генерується тут, до вставки.
    const id = randomUUID();
    return this.db.run(id, async (em) => {
      const tenant = await em.save(
        em.create(Tenant, {
          id,
          name: dto.name,
          apiKeyHash: hashApiKey(apiKey),
          webhookSecret,
          ...overridesFrom(dto.limits),
        }),
      );
      return {
        id: tenant.id,
        name: tenant.name,
        apiKey,
        webhookSecret,
        limits: await limitsView(em, tenant),
      };
    });
  }

  @Get(':id/limits')
  getLimits(@Param('id', ParseUUIDPipe) id: string): Promise<TenantLimitsView> {
    return this.db.run(id, async (em) =>
      limitsView(em, await this.tenant(em, id)),
    );
  }

  /**
   * Змінює перевизначення лімітів. Зниження нижче поточного використання не перериває роботу:
   * задачі в роботі завершуються, черга лишається, а новим захопленням і постановкам діє новий
   * ліміт (README, «Контракт лімітів»).
   */
  @Patch(':id/limits')
  updateLimits(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TenantLimitsDto,
  ): Promise<TenantLimitsView> {
    return this.db.run(id, async (em) => {
      await this.tenant(em, id);
      const changes = overridesFrom(dto);
      if (Object.keys(changes).length > 0)
        await em.update(Tenant, { id }, changes);
      return limitsView(em, await this.tenant(em, id));
    });
  }

  private async tenant(em: EntityManager, id: string): Promise<Tenant> {
    const tenant = await em.findOne(Tenant, { where: { id } });
    if (!tenant) throw new NotFoundException('Тенанта не знайдено');
    return tenant;
  }
}
