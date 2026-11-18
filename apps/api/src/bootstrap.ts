import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { EnvironmentVariables } from './config/env.validation';

/** Налаштування HTTP-застосунку, спільні для main.ts, worker.ts та інтеграційних тестів. */
export function configureApp(app: INestApplication): INestApplication {
  app.useLogger(app.get(Logger));
  // Більше тіло — 413 ще до розбору (межі значення — у env.validation.ts). Стиснені тіла
  // (Content-Encoding) — 415: API їх не потребує, а розпакування — код body-parser, досяжний до
  // автентифікації (README, «Аудит залежностей»).
  (app as NestExpressApplication).useBodyParser('json', {
    inflate: false,
    limit: app
      .get(ConfigService<EnvironmentVariables, true>)
      .get('HTTP_BODY_LIMIT', { infer: true }),
  });
  // Невідомі поля — 400, а не мовчазне відкидання: тенант бачить, що поле не діє.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableShutdownHooks();
  return app;
}
