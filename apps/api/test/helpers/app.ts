import { INestApplication, ModuleMetadata, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PARAMS_PROVIDER_TOKEN } from 'nestjs-pino';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { RUNTIME_DATABASE_URL } from '../../src/database/runtime-database-url';
import { installOpenApi } from '../../src/openapi/document';
import { buildPinoHttpOptions } from '../../src/observability/logger.options';
import { jsonLineSink } from './json-log-sink';
import { testWorkerDatabaseUrl } from './test-env';

export interface RunningApp {
  app: INestApplication;
  baseUrl: string;
  /** Рядки логу застосунку (лише якщо startApp викликано з captureLogs). */
  logs: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

export interface StartOptions extends ModuleMetadata {
  /** Писати логи (рівень info, справжня конфігурація логера) у масив logs замість stdout. */
  captureLogs?: boolean;
  openApi?: boolean;
}

/**
 * Піднімає справжній Nest-застосунок (з тими самими налаштуваннями, що й main.ts)
 * на випадковому порту. Запити — через вбудований fetch.
 */
export async function startApp(
  rootModule: Type = AppModule,
  options: StartOptions = {},
): Promise<RunningApp> {
  const { captureLogs, openApi, ...extra } = options;
  const logs: Array<Record<string, unknown>> = [];
  let builder = Test.createTestingModule({
    ...extra,
    imports: [rootModule, ...(extra.imports ?? [])],
  });
  // API і воркер у тестах живуть в одному процесі з одним DATABASE_URL (роль API); воркер, як і
  // в compose, ходить у БД власною роллю.
  if (rootModule.name === 'WorkerModule')
    builder = builder
      .overrideProvider(RUNTIME_DATABASE_URL)
      .useValue(testWorkerDatabaseUrl());
  if (captureLogs) {
    const sink = jsonLineSink(logs);
    builder = builder
      .overrideProvider(PARAMS_PROVIDER_TOKEN)
      .useValue({ pinoHttp: [buildPinoHttpOptions('info'), sink] });
  }
  const moduleRef = await builder.compile();
  const app = configureApp(
    moduleRef.createNestApplication({ bufferLogs: true }),
  );
  if (openApi) installOpenApi(app);
  await app.listen(0, '127.0.0.1');
  const { port } = (app.getHttpServer() as Server).address() as AddressInfo;
  return {
    app,
    baseUrl: `http://127.0.0.1:${port}`,
    logs,
    close: () => app.close(),
  };
}
