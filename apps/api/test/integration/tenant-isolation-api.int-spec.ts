import { DataSource } from 'typeorm';
import { Execution, Job, StepRun, Workflow } from '../../src/entities';
import { RunningApp, startApp } from '../helpers/app';
import {
  createExecution,
  createTenant,
  createWorkflow,
  openTestDataSource,
  TestTenant,
  truncateAll,
} from '../helpers/db';
import { api } from '../helpers/queue';

/**
 * Ізоляція тенантів на межі HTTP: ключ тенанта B проти кожного ресурсу тенанта A. Чужий ресурс
 * має бути неіснуючим (404 / відсутнім у списку), а дані A — незмінними після будь-якої спроби B
 * (перевіряється прямим читанням БД власником).
 */
describe('tenant isolation over HTTP', () => {
  let ds: DataSource;
  let app: RunningApp;
  let a: TestTenant;
  let b: TestTenant;
  let wfA: Workflow;
  let failedA: Execution;

  beforeAll(async () => {
    ds = await openTestDataSource();
    app = await startApp();
  });

  beforeEach(async () => {
    await truncateAll(ds);
    a = await createTenant(ds, 'tenant-a');
    b = await createTenant(ds, 'tenant-b');
    wfA = await createWorkflow(ds, a.tenant.id, 'wf-a');
    failedA = await createExecution(ds, wfA, {
      status: 'failed',
      input: { secret: 'a-only' },
      error: 'boom',
      finishedAt: new Date(),
    });
    await ds.getRepository(StepRun).save({
      executionId: failedA.id,
      tenantId: a.tenant.id,
      stepIndex: 0,
      stepId: 'say',
      status: 'failed',
      error: 'boom',
    });
    await ds.getRepository(Job).save({
      tenantId: a.tenant.id,
      executionId: failedA.id,
      status: 'failed',
      finishedAt: new Date(),
    });
  });

  afterAll(async () => {
    await app.close();
    await ds.destroy();
  });

  const asB = <T = unknown>(method: string, path: string, body?: unknown) =>
    api<T>(app.baseUrl, b.apiKey, method, path, body);

  /** Стан даних A, який не повинна змінити жодна дія B. */
  async function snapshotA(): Promise<Record<string, unknown[]>> {
    const rows = (sql: string): Promise<unknown[]> =>
      ds.query(sql, [a.tenant.id]);
    return {
      workflows: await rows(
        `SELECT id, name, steps, version, enabled FROM workflows WHERE "tenantId" = $1 ORDER BY id`,
      ),
      executions: await rows(
        `SELECT id, status, error, output FROM executions WHERE "tenantId" = $1 ORDER BY id`,
      ),
      jobs: await rows(
        `SELECT id, status, attempts FROM jobs WHERE "tenantId" = $1 ORDER BY id`,
      ),
    };
  }

  it('GET /executions/:id of another tenant is 404 and leaks nothing', async () => {
    const res = await asB<Record<string, unknown>>(
      'GET',
      `/executions/${failedA.id}`,
    );
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('a-only');
  });

  it('GET /executions of tenant B does not list executions of A', async () => {
    const res = await asB<{ items: Array<{ id: string }> }>(
      'GET',
      '/executions',
    );
    expect(res.status).toBe(200);
    expect(res.body.items.map((e) => e.id)).not.toContain(failedA.id);
  });

  it('POST /executions/:id/retry of another tenant is 404 and changes nothing', async () => {
    const before = await snapshotA();
    const res = await asB('POST', `/executions/${failedA.id}/retry`);
    expect(res.status).toBe(404);
    expect(await snapshotA()).toEqual(before);
  });

  it('workflow endpoints of another tenant are 404 and change nothing', async () => {
    const before = await snapshotA();
    expect((await asB('GET', `/workflows/${wfA.id}`)).status).toBe(404);
    expect(
      (await asB('PATCH', `/workflows/${wfA.id}`, { name: 'hijacked' })).status,
    ).toBe(404);
    expect((await asB('DELETE', `/workflows/${wfA.id}`)).status).toBe(404);
    expect(
      (await asB('POST', `/workflows/${wfA.id}/run`, { x: 1 })).status,
    ).toBe(404);
    const list = await asB<{ items: Array<{ id: string }> }>(
      'GET',
      '/workflows',
    );
    expect(list.status).toBe(200);
    expect(list.body.items.map((w) => w.id)).not.toContain(wfA.id);
    expect(await snapshotA()).toEqual(before);
  });
});
