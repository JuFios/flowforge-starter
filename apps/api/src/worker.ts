import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { WorkerModule } from './app.module';
import { configureApp } from './bootstrap';
import { EnvironmentVariables } from './config/env.validation';
import { JobRunnerService } from './engine/job-runner.service';
import { OutboxSender } from './outbox/outbox-sender.service';

async function bootstrap() {
  const app = configureApp(
    await NestFactory.create(WorkerModule, { bufferLogs: true }),
  );
  const port = app
    .get(ConfigService<EnvironmentVariables, true>)
    .get('WORKER_HTTP_PORT', { infer: true });
  await app.listen(port);
  app.get(Logger).log(`flowforge-worker service endpoints on ${port}`);
  app.get(JobRunnerService).start();
  app.get(OutboxSender).start();
}
// Помилка старту (невалідна конфігурація, недоступна БД) має завершувати процес з ненульовим
// кодом явно, а не через необроблене відхилення промісу.
bootstrap().catch((err: unknown) => {
  console.error('flowforge-worker failed to start', err);
  process.exit(1);
});
