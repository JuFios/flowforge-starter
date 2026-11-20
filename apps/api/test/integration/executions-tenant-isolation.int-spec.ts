import { DataSource } from 'typeorm';
import { ExecutionsService } from '../../src/executions/executions.service';
import { RunningApp, startApp } from '../helpers/app';
import {
  createTenant,
  createWorkflow,
  openTestDataSource,
  TestTenant,
  truncateAll,
} from '../helpers/db';

/**
 * Замінює unit-тест test/executions.service.spec.ts, який перевіряв лише те, що мок
 * повертає порожній масив, і лишався зеленим без фільтра за тенантом (див. README).
 * Тут дані двох тенантів реально лежать у Postgres.
 */
describe('executions listing is scoped to the tenant (real Postgres)', () => {
  let ds: DataSource;
  let running: RunningApp;
  let a: TestTenant;
  let b: TestTenant;
  let aExecutionIds: string[];

  beforeAll(async () => {
    ds = await openTestDataSource();
    running = await startApp();
  });

  beforeEach(async () => {
    await truncateAll(ds);
    a = await createTenant(ds, 'tenant-a');
    b = await createTenant(ds, 'tenant-b');
    const service = running.app.get(ExecutionsService);
    const wfA = await createWorkflow(ds, a.tenant.id, 'wf-a');
    const wfB = await createWorkflow(ds, b.tenant.id, 'wf-b');
    aExecutionIds = [];
    for (let i = 0; i < 3; i++)
      aExecutionIds.push((await service.enqueue(wfA, { i }, 'api')).id);
    for (let i = 0; i < 2; i++) await service.enqueue(wfB, { i }, 'api');
  });

  afterAll(async () => {
    await running.close();
    await ds.destroy();
  });

  it('service.list returns only executions of the requested tenant', async () => {
    const result = await running.app.get(ExecutionsService).list(a.tenant.id);
    expect(result.items.map((e) => e.id).sort()).toEqual(
      [...aExecutionIds].sort(),
    );
    expect(result.items.every((e) => e.workflowName === 'wf-a')).toBe(true);
  });

  it('GET /executions returns only executions of the caller tenant', async () => {
    const res = await fetch(`${running.baseUrl}/executions`, {
      headers: { 'x-api-key': a.apiKey },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((e) => e.id).sort()).toEqual(
      [...aExecutionIds].sort(),
    );
  });
});
