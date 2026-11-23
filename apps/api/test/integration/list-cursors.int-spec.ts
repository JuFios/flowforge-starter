import { DataSource } from 'typeorm';
import { Workflow } from '../../src/entities';
import { RunningApp, startApp } from '../helpers/app';
import {
  createTenant,
  createWorkflow,
  openTestDataSource,
  truncateAll,
} from '../helpers/db';

interface Page {
  items: Array<{ id: string }>;
  nextCursor: string | null;
}

/**
 * Курсор сторінки прив'язаний до свого списку й фільтра (OpenAPI: «з тими самими фільтрами»).
 * Клас перевіряється повністю: курсор кожної пари (список, фільтр) подається в кожну іншу. Чужий
 * курсор — 400, а не тиха сторінка іншого набору з позиції чужого рядка.
 */
describe('list cursors', () => {
  let owner: DataSource;
  let apiApp: RunningApp;

  beforeAll(async () => {
    owner = await openTestDataSource();
    apiApp = await startApp();
  });

  beforeEach(() => truncateAll(owner));

  afterAll(async () => {
    await apiApp.close();
    await truncateAll(owner);
    await owner.destroy();
  });

  async function get(apiKey: string, path: string): Promise<Response> {
    return fetch(`${apiApp.baseUrl}${path}`, {
      headers: { 'x-api-key': apiKey },
    });
  }

  async function execution(wf: Workflow, status: string, at: string) {
    await owner.query(
      `INSERT INTO executions ("tenantId", "workflowId", "workflowVersionId", status, input,
                               "createdAt", "finishedAt")
       SELECT $1, $2, v.id, $3::varchar, '{}'::jsonb, $4::timestamptz,
              CASE WHEN $3 IN ('succeeded', 'failed') THEN $4::timestamptz END
         FROM workflow_versions v WHERE v."workflowId" = $2 AND v.version = 1`,
      [wf.tenantId, wf.id, status, at],
    );
  }

  async function event(tenantId: string, status: string, at: string) {
    await owner.query(
      `INSERT INTO outbox_events ("tenantId", "executionId", sequence, type, payload, status,
                                  "leaseToken", "leaseUntil", "deliveredAt", "cancelledAt",
                                  "createdAt")
       VALUES ($1, gen_random_uuid(), 1, 'execution.succeeded', '{}', $2::varchar,
               CASE WHEN $2 = 'sending' THEN gen_random_uuid() END,
               CASE WHEN $2 = 'sending' THEN now() + interval '1 minute' END,
               CASE WHEN $2 = 'delivered' THEN $3::timestamptz END,
               CASE WHEN $2 = 'cancelled' THEN $3::timestamptz END,
               $3::timestamptz)`,
      [tenantId, status, at],
    );
  }

  it('rejects a cursor of every other list and filter', async () => {
    const { tenant, apiKey } = await createTenant(owner);
    const first = await createWorkflow(owner, tenant.id, 'first');
    const second = await createWorkflow(owner, tenant.id, 'second');
    // По два рядки на кожну пару, щоб кожна перша сторінка з limit=1 мала курсор.
    for (const [i, [wf, status]] of (
      [
        [first, 'failed'],
        [first, 'failed'],
        [second, 'succeeded'],
        [second, 'succeeded'],
      ] as const
    ).entries())
      await execution(wf, status, `2026-03-01T10:00:0${i}Z`);
    const statuses = ['pending', 'sending', 'delivered', 'cancelled'];
    for (const [i, status] of statuses.flatMap((s) => [s, s]).entries())
      await event(tenant.id, status, `2026-03-02T10:00:${10 + i}Z`);

    const events = '/tenants/me/notifications/events?limit=1';
    const lists = [
      '/workflows?limit=1',
      '/executions?limit=1',
      '/executions?limit=1&status=failed',
      `/executions?limit=1&workflowId=${first.id}`,
      `/executions?limit=1&status=failed&workflowId=${first.id}`,
      events,
      ...statuses.map((status) => `${events}&status=${status}`),
    ];
    const cursors = new Map<string, string>();
    for (const list of lists) {
      const res = await get(apiKey, list);
      expect(res.status).toBe(200);
      const page = (await res.json()) as Page;
      expect(page.nextCursor).toEqual(expect.any(String));
      cursors.set(list, encodeURIComponent(page.nextCursor!));
    }

    const accepted: string[] = [];
    for (const [issuedBy, cursor] of cursors)
      for (const list of lists) {
        const res = await get(apiKey, `${list}&cursor=${cursor}`);
        const body = (await res.json()) as { message?: string[] };
        if (list === issuedBy) {
          expect(res.status).toBe(200);
          continue;
        }
        if (res.status !== 400) accepted.push(`${issuedBy} -> ${list}`);
        else expect(body.message).toEqual(['cursor does not match the filter']);
      }
    expect(accepted).toEqual([]);
  });
});
