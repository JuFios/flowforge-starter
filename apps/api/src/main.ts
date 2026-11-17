import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { EnvironmentVariables } from './config/env.validation';

async function bootstrap() {
  const app = configureApp(
    await NestFactory.create(AppModule, { bufferLogs: true }),
  );
  const port = app
    .get(ConfigService<EnvironmentVariables, true>)
    .get('PORT', { infer: true });
  await app.listen(port);
  app.get(Logger).log(`flowforge-api listening on ${port}`);
}
bootstrap();
