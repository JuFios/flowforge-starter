import { INestApplication, ModuleMetadata, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';

export interface RunningApp {
  app: INestApplication;
  baseUrl: string;
  close(): Promise<void>;
}

/**
 * Піднімає справжній Nest-застосунок (з тими самими налаштуваннями, що й main.ts)
 * на випадковому порту. Запити — через вбудований fetch.
 */
export async function startApp(rootModule: Type = AppModule, extra: ModuleMetadata = {}): Promise<RunningApp> {
  const moduleRef = await Test.createTestingModule({ ...extra, imports: [rootModule, ...(extra.imports ?? [])] }).compile();
  const app = configureApp(moduleRef.createNestApplication({ bufferLogs: true }));
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { app, baseUrl: `http://127.0.0.1:${port}`, close: () => app.close() };
}
