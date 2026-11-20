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
  items: Array<Record<string, unknown> & { id: string; status: string }>;
  nextCursor: string | null;
}

/**
 * Список виконань (ТЗ 3.3.11, беклог PR 6): курсор `(createdAt, id)`, фільтр за статусом і
 * workflow, `limit` 1..200 з валідацією на межі API. У списку лише поля огляду: без `input` і
 * `output`, обсяг яких задає тенант.
 */
describe('paged execution list', () => {
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

  function list(apiKey: string, query = ''): Promise<Response> {
    return fetch(`${apiApp.baseUrl}/executions${query}`, {
      headers: { 'x-api-key': apiKey },
    });
  }

  /** Виконання з точним моментом створення (текст із мікросекундами). */
  async function insert(
    wf: Workflow,
    createdAt: string,
    fields: { status?: string; output?: unknown; input?: unknown } = {},
  ): Promise<string> {
    const [{ id }] = (await owner.query(
      `INSERT INTO executions ("tenantId", "workflowId", "workflowVersionId", status, input,
                               output, "createdAt", "finishedAt")
       SELECT $1, $2, v.id, $3::varchar, $4::jsonb, $5::jsonb, $6::timestamptz,
              CASE WHEN $3 IN ('succeeded', 'failed') THEN $6::timestamptz END
         FROM workflow_versions v WHERE v."workflowId" = $2 AND v.version = 1
       RETURNING id`,
      [
        wf.tenantId,
        wf.id,
        fields.status ?? 'succeeded',
        JSON.stringify(fields.input ?? {}),
        fields.output === undefined ? null : JSON.stringify(fields.output),
        createdAt,
      ],
    )) as Array<{ id: string }>;
    return id;
  }

  async function walk(apiKey: string, query: string): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let pages = 0; pages < 200; pages++) {
      const res = await list(
        apiKey,
        `?${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      expect(res.status).toBe(200);
      const page = (await res.json()) as Page;
      ids.push(...page.items.map((e) => e.id));
      cursor = page.nextCursor;
      if (!cursor) return ids;
    }
    throw new Error('the cursor never ended');
  }

  it.each([
    'limit=abc',
    'limit=1.5',
    'limit=-5',
    'limit=0',
    'limit=201',
    'limit=1e2',
    'limit=',
    'status=done',
    'status=',
    'workflowId=not-a-uuid',
    'cursor=***',
    'unknown=1',
  ])('rejects %s with 400', async (query) => {
    const { apiKey } = await createTenant(owner);
    const res = await list(apiKey, `?${query}`);
    expect(res.status).toBe(400);
  });

  it('walks every execution once in (createdAt, id) order with equal and microsecond-apart moments', async () => {
    const { tenant, apiKey } = await createTenant(owner);
    const wf = await createWorkflow(owner, tenant.id);
    const same = '2026-03-01T10:00:00.000500Z';
    for (let i = 0; i < 6; i++) await insert(wf, same);
    for (const at of [
      '2026-03-01T10:00:00.000499Z',
      '2026-03-01T10:00:00.000501Z',
      '2026-03-01T10:00:00.002Z',
    ])
      await insert(wf, at);
    const order = await owner.query<Array<{ id: string }>>(
      `SELECT id FROM executions WHERE "tenantId" = $1 ORDER BY "createdAt" DESC, id DESC`,
      [tenant.id],
    );
    for (const limit of [1, 2, 4, 9, 200])
      expect(await walk(apiKey, `limit=${limit}`)).toEqual(
        order.map((r) => r.id),
      );
  });

  it('filters by status and by workflow, page by page', async () => {
    const { tenant, apiKey } = await createTenant(owner);
    const wf1 = await createWorkflow(owner, tenant.id, 'one');
    const wf2 = await createWorkflow(owner, tenant.id, 'two');
    const statuses = ['pending', 'running', 'succeeded', 'failed'];
    for (let i = 0; i < 24; i++)
      await insert(
        i % 2 ? wf1 : wf2,
        `2026-03-01T10:00:${String(i).padStart(2, '0')}Z`,
        { status: statuses[i % 4] },
      );
    for (const status of statuses) {
      const expected = await owner.query<Array<{ id: string }>>(
        `SELECT id FROM executions WHERE "tenantId" = $1 AND status = $2
          ORDER BY "createdAt" DESC, id DESC`,
        [tenant.id, status],
      );
      expect(await walk(apiKey, `limit=2&status=${status}`)).toEqual(
        expected.map((r) => r.id),
      );
    }
    const ofWf1 = await owner.query<Array<{ id: string }>>(
      `SELECT id FROM executions WHERE "workflowId" = $1 ORDER BY "createdAt" DESC, id DESC`,
      [wf1.id],
    );
    expect(await walk(apiKey, `limit=5&workflowId=${wf1.id}`)).toEqual(
      ofWf1.map((r) => r.id),
    );
    const both = await walk(
      apiKey,
      `limit=1&workflowId=${wf1.id}&status=running`,
    );
    expect(both.length).toBeGreaterThan(0);
    const page = (await (
      await list(apiKey, `?workflowId=${wf1.id}&status=running`)
    ).json()) as Page;
    for (const item of page.items) {
      expect(item.status).toBe('running');
      expect(item.workflowId).toBe(wf1.id);
      expect(item.workflowName).toBe('one');
    }
  });

  it('rejects a cursor issued for another filter', async () => {
    const { tenant, apiKey } = await createTenant(owner);
    const wf = await createWorkflow(owner, tenant.id);
    for (let i = 0; i < 3; i++)
      await insert(wf, `2026-03-01T10:00:0${i}Z`, { status: 'failed' });
    const first = (await (
      await list(apiKey, '?limit=1&status=failed')
    ).json()) as Page;
    const cursor = encodeURIComponent(first.nextCursor!);
    expect(
      (await list(apiKey, `?limit=1&status=failed&cursor=${cursor}`)).status,
    ).toBe(200);
    for (const other of ['', '&status=succeeded', `&workflowId=${wf.id}`]) {
      const res = await list(apiKey, `?limit=1${other}&cursor=${cursor}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        message: ['cursor does not match the filter'],
      });
    }
  });

  it('keeps the walk free of duplicates when statuses change between pages', async () => {
    const { tenant, apiKey } = await createTenant(owner);
    const wf = await createWorkflow(owner, tenant.id);
    for (let i = 0; i < 6; i++)
      await insert(wf, `2026-03-01T10:00:0${i}Z`, { status: 'running' });
    const first = (await (
      await list(apiKey, '?limit=2&status=running')
    ).json()) as Page;
    // Між сторінками два ще не прочитані виконання завершуються.
    await owner.query(
      `UPDATE executions SET status = 'succeeded', "finishedAt" = now()
        WHERE id IN (SELECT id FROM executions WHERE status = 'running'
                      ORDER BY "createdAt" ASC LIMIT 2)`,
    );
    const rest = await walk(
      apiKey,
      `limit=2&status=running&cursor=${encodeURIComponent(first.nextCursor!)}`,
    );
    const all = [...first.items.map((e) => e.id), ...rest];
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(4);
  });

  it('lists only overview fields: neither input nor output reach the page', async () => {
    const { tenant, apiKey } = await createTenant(owner);
    const wf = await createWorkflow(owner, tenant.id);
    await insert(wf, '2026-03-01T10:00:00Z', {
      input: { secret: 'input-marker' },
      output: { body: 'output-marker' },
    });
    const text = await (await list(apiKey)).text();
    expect(text).not.toContain('input-marker');
    expect(text).not.toContain('output-marker');
    const page = JSON.parse(text) as Page;
    expect(Object.keys(page.items[0]).sort()).toEqual(
      [
        'id',
        'workflowId',
        'workflowName',
        'workflowVersion',
        'status',
        'trigger',
        'error',
        'createdAt',
        'finishedAt',
        'scheduledAt',
        'correlationId',
      ].sort(),
    );
  });

  it('answers with the same size for large and small outputs', async () => {
    const small = await createTenant(owner, 'small');
    const large = await createTenant(owner, 'large');
    const wfS = await createWorkflow(owner, small.tenant.id);
    const wfL = await createWorkflow(owner, large.tenant.id);
    const big = { body: 'x'.repeat(256 * 1024) };
    for (let i = 0; i < 20; i++) {
      const at = `2026-03-01T10:00:${String(i).padStart(2, '0')}Z`;
      await insert(wfS, at, { output: { body: 'x' } });
      await insert(wfL, at, { output: big, input: { pad: 'y'.repeat(32000) } });
    }
    const strip = (text: string) =>
      text
        .replace(
          /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
          '',
        )
        .replace(/"nextCursor":"[^"]+"/, '');
    const a = await (await list(small.apiKey, '?limit=200')).text();
    const b = await (await list(large.apiKey, '?limit=200')).text();
    expect(Buffer.byteLength(strip(b))).toBe(Buffer.byteLength(strip(a)));
  });

  it('isolates tenants and shows an empty page without executions', async () => {
    const a = await createTenant(owner, 'a');
    const b = await createTenant(owner, 'b');
    const wfA = await createWorkflow(owner, a.tenant.id);
    for (let i = 0; i < 3; i++) await insert(wfA, `2026-03-01T10:00:0${i}Z`);
    expect(await (await list(b.apiKey)).json()).toEqual({
      items: [],
      nextCursor: null,
    });
    const pageA = (await (await list(a.apiKey, '?limit=1')).json()) as Page;
    const res = await list(
      b.apiKey,
      `?cursor=${encodeURIComponent(pageA.nextCursor!)}`,
    );
    expect(await res.json()).toEqual({ items: [], nextCursor: null });
  });
});
