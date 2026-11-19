import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { hashApiKey } from '../../src/auth/api-key.guard';
import { buildDataSourceOptions } from '../../src/database/database.options';
import {
  Execution,
  Tenant,
  Workflow,
  WorkflowVersion,
} from '../../src/entities';
import { testDatabaseEnv } from './test-env';

/** Окреме підключення до тестової БД (для підготовки даних і перевірок прямим SQL). */
export async function openTestDataSource(): Promise<DataSource> {
  return new DataSource(buildDataSourceOptions(testDatabaseEnv())).initialize();
}

/**
 * Очищає всі таблиці застосунку (таблиця міграцій лишається). Лише наявні: тести міграцій
 * тимчасово відкочують схему, і новіших таблиць у цей момент ще немає.
 */
export async function truncateAll(ds: DataSource): Promise<void> {
  // Відра лімітів частоти — теж: ліміти за IP (127.0.0.1) інакше переходили б між тестами.
  const names = [
    ...ds.entityMetadatas.map((m) => m.tableName),
    'rate_limit_buckets',
    'notification_settings',
    'outbox_events',
    'outbox_attempts',
  ];
  const existing: Array<{ name: string }> = await ds.query(
    `SELECT table_name AS name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [names],
  );
  if (existing.length === 0) return;
  const tables = existing.map((t) => `"${t.name}"`).join(', ');
  await ds.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
}

export interface TestTenant {
  tenant: Tenant;
  apiKey: string;
}

export async function createTenant(
  ds: DataSource,
  name = 'tenant',
): Promise<TestTenant> {
  const apiKey = `ff_test_${randomBytes(12).toString('hex')}`;
  const tenant = await ds.getRepository(Tenant).save({
    name,
    apiKeyHash: hashApiKey(apiKey),
    webhookSecret: randomBytes(16).toString('hex'),
  });
  return { tenant, apiKey };
}

/** Workflow з першою версією — так, як його створює WorkflowsService. */
export async function createWorkflow(
  ds: DataSource,
  tenantId: string,
  name = 'wf',
): Promise<Workflow> {
  const wf = await ds.getRepository(Workflow).save({
    tenantId,
    name,
    steps: [{ id: 'say', type: 'log', message: 'hello {{ input.name }}' }],
  });
  await ds.getRepository(WorkflowVersion).save({
    workflowId: wf.id,
    tenantId,
    version: wf.version,
    steps: wf.steps,
  });
  return wf;
}

/** Execution зі знімком поточної версії workflow (як ExecutionsService.enqueue, але без job). */
export async function createExecution(
  ds: DataSource,
  wf: Workflow,
  fields: Partial<Execution> = {},
): Promise<Execution> {
  const version = await ds
    .getRepository(WorkflowVersion)
    .findOneByOrFail({ workflowId: wf.id, version: wf.version });
  return ds.getRepository(Execution).save({
    tenantId: wf.tenantId,
    workflowId: wf.id,
    workflowVersionId: version.id,
    ...fields,
  });
}
