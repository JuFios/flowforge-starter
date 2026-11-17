import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { hashApiKey } from '../../src/auth/api-key.guard';
import { buildDataSourceOptions } from '../../src/database/database.options';
import { Tenant, Workflow } from '../../src/entities';
import { testDatabaseEnv } from './test-env';

/** Окреме підключення до тестової БД (для підготовки даних і перевірок прямим SQL). */
export async function openTestDataSource(): Promise<DataSource> {
  return new DataSource(buildDataSourceOptions(testDatabaseEnv())).initialize();
}

/** Очищає всі таблиці застосунку (таблиця міграцій лишається). */
export async function truncateAll(ds: DataSource): Promise<void> {
  const tables = ds.entityMetadatas.map((m) => `"${m.tableName}"`).join(', ');
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

export async function createWorkflow(
  ds: DataSource,
  tenantId: string,
  name = 'wf',
): Promise<Workflow> {
  return ds.getRepository(Workflow).save({
    tenantId,
    name,
    steps: [{ id: 'say', type: 'log', message: 'hello {{ input.name }}' }],
  });
}
