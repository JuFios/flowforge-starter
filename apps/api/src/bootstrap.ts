import { raw } from 'express';
import {
  ArgumentMetadata,
  BadRequestException,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { CreateTenantDto } from './tenants/tenants.controller';
import { LIMIT_FIELDS } from './tenants/tenant-limits.dto';
import { getMetadataStorage } from 'class-validator';
import {
  deferInvalidUtf8ParseError,
  ExactJsonNumbersInterceptor,
  markInexactJsonNumbers,
} from './common/exact-json-numbers';
import { exceedsJsonDepth, jsonTooDeepMessage } from './common/json-depth';
import { EnvironmentVariables, parseTrustProxy } from './config/env.validation';
import {
  CreateWorkflowDto,
  UpdateWorkflowDto,
} from './workflows/dto/workflow.dto';

/** Масив steps має власну схему в validateSteps. Зберігаємо в ньому всі ключі JSON,
 * зокрема імена заголовків, які Nest і class-transformer видаляють під час обробки DTO. */
class ApiValidationPipe extends ValidationPipe {
  override async transform(
    value: unknown,
    metadata: ArgumentMetadata,
  ): Promise<unknown> {
    // Тіла-DTO — до class-transformer і class-validator: вони обходять значення рекурсивно.
    // Пайп виконується після guard-ів, тож неавтентифікований запит отримує 401, а не пояснення.
    // Тіла без DTO (вхід виконання, webhook) перевіряє parseRunInput — у webhook-а після підпису.
    if (
      metadata.type === 'body' &&
      metadata.metatype &&
      this.toValidate(metadata)
    ) {
      if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw new BadRequestException('тіло запиту має бути об’єктом');
      if (exceedsJsonDepth(value))
        throw new BadRequestException(jsonTooDeepMessage('тіло запиту'));
      // Перевіряємо вихідні ключі JSON, поки class-transformer ще не відкинув частину з них.
      const fields = getMetadataStorage().getTargetValidationMetadatas(
        metadata.metatype,
        '',
        false,
        false,
      );
      const allowed = new Set(fields.map((field) => field.propertyName));
      const unknown = Object.keys(value).filter((key) => !allowed.has(key));
      if (
        metadata.metatype === CreateTenantDto &&
        'limits' in value &&
        value.limits &&
        typeof value.limits === 'object' &&
        !Array.isArray(value.limits)
      ) {
        const permitted = new Set<string>(LIMIT_FIELDS);
        unknown.push(
          ...Object.keys(value.limits)
            .filter((k) => !permitted.has(k))
            .map((k) => 'limits.' + k),
        );
      }
      if (unknown.length)
        throw new BadRequestException(
          unknown.map((key) => `property ${key} should not exist`),
        );
    }
    if (
      (metadata.metatype === CreateWorkflowDto ||
        metadata.metatype === UpdateWorkflowDto) &&
      typeof value === 'object' &&
      value !== null &&
      'steps' in value &&
      Array.isArray(value.steps)
    ) {
      const dto = (await super.transform({ ...value, steps: [] }, metadata)) as
        CreateWorkflowDto | UpdateWorkflowDto;
      dto.steps = value.steps;
      return dto;
    }
    return super.transform(value, metadata);
  }
}

/** Налаштування HTTP-застосунку, спільні для main.ts, worker.ts та інтеграційних тестів. */
export function configureApp(app: INestApplication): INestApplication {
  app.useLogger(app.get(Logger));
  // Більше тіло — 413 ще до розбору (межі значення — у env.validation.ts). Стиснені тіла
  // (Content-Encoding) — 415: API їх не потребує, а розпакування — код body-parser, досяжний до
  // автентифікації (README, «Аудит залежностей»).
  const http = app as NestExpressApplication;
  const config = app.get(ConfigService<EnvironmentVariables, true>);
  // IP клієнта для лімітів за IP (req.ip): X-Forwarded-For — лише від довірених проксі.
  http.set(
    'trust proxy',
    parseTrustProxy(config.get('TRUST_PROXY', { infer: true })) ?? false,
  );
  // Відповіді API містять дані тенанта (визначення, виходи кроків, секрети при видачі): жоден
  // спільний чи браузерний кеш не зберігає їх. Маршрути можуть поставити суворіший заголовок самі.
  http.use(
    (
      _req: unknown,
      res: { setHeader(n: string, v: string): void },
      next: () => void,
    ) => {
      res.setHeader('Cache-Control', 'no-store');
      next();
    },
  );
  const options = {
    inflate: false,
    limit: config.get('HTTP_BODY_LIMIT', { infer: true }),
  };
  http.use('/hooks', raw({ ...options, type: () => true }));
  // Числа, які змінилися б після розбору (1e400, цілі поза точністю double), видно лише в сирому
  // тексті: verify позначає запит, 400 — після guard-ів (ExactJsonNumbersInterceptor).
  http.useBodyParser('json', { ...options, verify: markInexactJsonNumbers });
  http.use(deferInvalidUtf8ParseError);
  http.useBodyParser('urlencoded', { ...options, extended: true });
  // Невідомі поля — 400, а не мовчазне відкидання: тенант бачить, що поле не діє.
  app.useGlobalPipes(
    new ApiValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalInterceptors(new ExactJsonNumbersInterceptor());
  app.enableShutdownHooks();
  return app;
}
