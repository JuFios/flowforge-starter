import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';

/**
 * Найбільше JSON-тіло запиту. Більше — 413 ще до розбору. Найбільші легітимні тіла (визначення
 * workflow до 64 КіБ, вхід виконання до 64 КіБ) вміщуються з запасом.
 */
export const JSON_BODY_LIMIT = '100kb';

/** Налаштування HTTP-застосунку, спільні для main.ts, worker.ts та інтеграційних тестів. */
export function configureApp(app: INestApplication): INestApplication {
  app.useLogger(app.get(Logger));
  (app as NestExpressApplication).useBodyParser('json', {
    limit: JSON_BODY_LIMIT,
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
