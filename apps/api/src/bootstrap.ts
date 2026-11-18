import {
  ArgumentMetadata,
  BadRequestException,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { getMetadataStorage } from 'class-validator';
import { exceedsJsonDepth, jsonTooDeepMessage } from './common/json-depth';
import { EnvironmentVariables } from './config/env.validation';
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
      this.toValidate(metadata) &&
      exceedsJsonDepth(value)
    )
      throw new BadRequestException(jsonTooDeepMessage('тіло запиту'));
    if (
      metadata.type === 'body' &&
      metadata.metatype &&
      this.toValidate(metadata) &&
      value !== null &&
      typeof value === 'object'
    ) {
      // Перевіряємо вихідні ключі JSON, поки class-transformer ще не відкинув частину з них.
      const fields = getMetadataStorage().getTargetValidationMetadatas(
        metadata.metatype,
        '',
        false,
        false,
      );
      const allowed = new Set(fields.map((field) => field.propertyName));
      const unknown = Object.keys(value).filter((key) => !allowed.has(key));
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
  const options = {
    inflate: false,
    limit: app
      .get(ConfigService<EnvironmentVariables, true>)
      .get('HTTP_BODY_LIMIT', { infer: true }),
  };
  http.useBodyParser('json', options);
  http.useBodyParser('urlencoded', { ...options, extended: true });
  // Невідомі поля — 400, а не мовчазне відкидання: тенант бачить, що поле не діє.
  app.useGlobalPipes(
    new ApiValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableShutdownHooks();
  return app;
}
