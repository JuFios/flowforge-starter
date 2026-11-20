import {
  Body,
  Controller,
  Header,
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
  IsObject,
  ValidateIf,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { EntityManager } from 'typeorm';
import { hashApiKey } from '../auth/api-key.guard';
import { IsStorableText } from '../common/storable-text';
import { Tenant } from '../entities';
import { RateLimit } from '../limits/rate-limit.guard';
import { EffectiveLimits, TenantLimitOverrides } from '../tenancy/limits';
import { TenantDb } from '../tenancy/tenant-db';
import { AdminTokenGuard } from './admin-token.guard';
import { LIMIT_FIELDS, TenantLimitsDto } from './tenant-limits.dto';

export class CreateTenantDto {
  @IsString()
  @IsStorableText()
  @MinLength(2)
  @MaxLength(200)
  name: string;

  /** Перевизначення лімітів (необов'язково); без них — значення за замовчуванням. */
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsObject()
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
  id: string,
): Promise<TenantLimitsView> {
  const [view]: TenantLimitsView[] = await em.query(
    `SELECT jsonb_build_object(
       'maxConcurrentExecutions', t."maxConcurrentExecutions",
       'maxQueueSize', t."maxQueueSize", 'rateLimit', t."rateLimit",
       'webhookRateLimit', t."webhookRateLimit",
       'maxWorkflows', t."maxWorkflows") AS overrides,
       to_jsonb(l) AS effective
       FROM tenants t CROSS JOIN public.tenant_limits() l WHERE t.id = $1`,
    [id],
  );
  if (!view) throw new NotFoundException('Тенанта не знайдено');
  return view;
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
  @Header('Cache-Control', 'no-store')
  async create(@Body() dto: CreateTenantDto) {
    const apiKey = `ff_${randomBytes(24).toString('hex')}`;
    const webhookSecret = randomBytes(24).toString('hex');
    const webhookKeyId = randomUUID();
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
          webhookKeyId,
          ...overridesFrom(dto.limits),
        }),
      );
      return {
        id: tenant.id,
        name: tenant.name,
        apiKey,
        webhookSecret,
        // ID початкового ключа: за ним власник відкликає ключ після ротації (README 3.3.7).
        webhookKeyId,
        limits: await limitsView(em, id),
      };
    });
  }

  @Get(':id/limits')
  getLimits(@Param('id', ParseUUIDPipe) id: string): Promise<TenantLimitsView> {
    return this.db.run(id, (em) => limitsView(em, id));
  }

  /**
   * Змінює перевизначення лімітів. Зниження нижче поточного використання не перериває роботу:
   * задачі в роботі завершуються, черга лишається, а новим захопленням і постановкам діє новий
   * ліміт (docs/architecture.md, «Контракт лімітів»).
   */
  @Patch(':id/limits')
  updateLimits(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TenantLimitsDto,
  ): Promise<TenantLimitsView> {
    return this.db.run(id, async (em) => {
      const changes = overridesFrom(dto);
      if (Object.keys(changes).length > 0)
        await em.update(Tenant, { id }, changes);
      return limitsView(em, id);
    });
  }
}
