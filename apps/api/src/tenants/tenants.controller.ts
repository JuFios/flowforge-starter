import {
  Body,
  ConflictException,
  Controller,
  Header,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Res,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { randomUUID } from 'crypto';
import type { Response } from 'express';
import {
  IsObject,
  ValidateIf,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { EntityManager, QueryFailedError } from 'typeorm';
import { hashApiKey } from '../auth/api-key.guard';
import { IsApiKeyMaterial, IsSigningSecret } from '../common/key-material';
import { safeEqual } from '../common/safe-equal';
import { IsStorableText } from '../common/storable-text';
import { Tenant } from '../entities';
import { RateLimit } from '../limits/rate-limit.guard';
import { EffectiveLimits, TenantLimitOverrides } from '../tenancy/limits';
import { SystemDb } from '../tenancy/system-db';
import { TenantDb } from '../tenancy/tenant-db';
import { AdminTokenGuard } from './admin-token.guard';
import { LIMIT_FIELDS, TenantLimitsDto } from './tenant-limits.dto';

export class CreateTenantDto {
  @IsString()
  @IsStorableText()
  @MinLength(2)
  @MaxLength(200)
  name: string;

  /**
   * API-ключ тенанта, згенерований оператором (README, «Облікові дані»). Зберігається лише його
   * sha256; у відповідях ключ не повертається (ТЗ 4).
   */
  @IsApiKeyMaterial()
  apiKey: string;

  /** Перший ключ підпису вхідних webhook-ів, згенерований оператором; у відповідях не повертається. */
  @IsSigningSecret()
  webhookSecret: string;

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

/** Тенант у відповіді адмін-API: без облікових даних (ТЗ 4). */
interface TenantView {
  id: string;
  name: string;
  webhookKeyId: string;
  limits: TenantLimitsView;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof QueryFailedError &&
    (err.driverError as { code?: string } | undefined)?.code === '23505'
  );
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
  constructor(
    private readonly db: TenantDb,
    private readonly system: SystemDb,
  ) {}

  /**
   * Створення тенанта з обліковими даними, які згенерував оператор: відповідь містить лише ID,
   * назву, ID першого ключа підпису й ліміти. Повтор того самого запиту після втраченої відповіді
   * повертає чинного тенанта (200); інший запит із тим самим API-ключем — 409.
   */
  @Post()
  @Header('Cache-Control', 'no-store')
  async create(
    @Body() dto: CreateTenantDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TenantView> {
    const apiKeyHash = hashApiKey(dto.apiKey);
    const existing = await this.system.authTenant(apiKeyHash);
    if (existing) return this.replay(existing, dto, res);
    // Під RLS рядок тенанта видно й можна вставити лише в його власному контексті, тож id
    // генерується тут, до вставки.
    const id = randomUUID();
    const webhookKeyId = randomUUID();
    try {
      return await this.db.run(id, async (em) => {
        const tenant = await em.save(
          em.create(Tenant, {
            id,
            name: dto.name,
            apiKeyHash,
            webhookSecret: dto.webhookSecret,
            webhookKeyId,
            ...overridesFrom(dto.limits),
          }),
        );
        return {
          id: tenant.id,
          name: tenant.name,
          // ID початкового ключа: за ним власник відкликає ключ після ротації (README 3.3.7).
          webhookKeyId,
          limits: await limitsView(em, id),
        };
      });
    } catch (err) {
      // Паралельний такий самий запит устиг першим: відповідаємо так, як на повтор.
      const winner = isUniqueViolation(err)
        ? await this.system.authTenant(apiKeyHash)
        : null;
      if (winner) return this.replay(winner, dto, res);
      throw err;
    }
  }

  /** Повтор створення: той самий тенант лише за тієї самої назви й того самого ключа підпису. */
  private replay(
    id: string,
    dto: CreateTenantDto,
    res: Response,
  ): Promise<TenantView> {
    return this.db.run(id, async (em) => {
      const [row]: Array<{
        name: string;
        webhookSecret: string;
        webhookKeyId: string;
      }> = await em.query(
        'SELECT name, "webhookSecret", "webhookKeyId" FROM tenants WHERE id = $1',
        [id],
      );
      if (
        !row ||
        row.name !== dto.name ||
        !safeEqual(dto.webhookSecret, row.webhookSecret)
      )
        throw new ConflictException('Цей API-ключ уже використовується');
      res.status(200);
      return {
        id,
        name: row.name,
        webhookKeyId: row.webhookKeyId,
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
