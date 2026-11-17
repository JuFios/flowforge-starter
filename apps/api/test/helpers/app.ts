import { INestApplication, ModuleMetadata, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PARAMS_PROVIDER_TOKEN } from 'nestjs-pino';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { buildPinoHttpOptions } from '../../src/observability/logger.options';

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
}

/**
 * Піднімає справжній Nest-застосунок (з тими самими налаштуваннями, що й main.ts)
 * на випадковому порту. Запити — через вбудований fetch.
 */
export async function startApp(rootModule: Type = AppModule, options: StartOptions = {}): Promise<RunningApp> {
  const { captureLogs, ...extra } = options;
  const logs: Array<Record<string, unknown>> = [];
  let builder = Test.createTestingModule({ ...extra, imports: [rootModule, ...(extra.imports ?? [])] });
  if (captureLogs) {
    const sink = new Writable({
      write(chunk, _enc, cb) {
        for (const line of chunk.toString().split('\n').filter(Boolean)) logs.push(JSON.parse(line));
        cb();
      },
    });
    builder = builder.overrideProvider(PARAMS_PROVIDER_TOKEN).useValue({ pinoHttp: [buildPinoHttpOptions('info'), sink] });
  }
  const moduleRef = await builder.compile();
  const app = configureApp(moduleRef.createNestApplication({ bufferLogs: true }));
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { app, baseUrl: `http://127.0.0.1:${port}`, logs, close: () => app.close() };
}
