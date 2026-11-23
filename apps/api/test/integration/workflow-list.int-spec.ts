import { DataSource } from 'typeorm';
import { RunningApp, startApp } from '../helpers/app';
import { createTenant, openTestDataSource, truncateAll } from '../helpers/db';

interface Page {
  items: Array<Record<string, unknown> & { id: string }>;
  nextCursor: string | null;
}

/**
 * Список workflow (беклог PR 6, P1): обмежена сторінка з курсором `(createdAt, id)` з точністю
 * PostgreSQL до мікросекунди. У списку лише поля огляду, без `steps`.
 */
describe('paged workflow list', () => {
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
    return fetch(`${apiApp.baseUrl}/workflows${query}`, {
      headers: { 'x-api-key': apiKey },
    });
  }

  /** Вставляє workflow з точним createdAt (текст із мікросекундами) і повертає id. */
  async function insert(
    tenantId: string,
    createdAt: string,
    steps: unknown[] = [{ id: 'say', type: 'log', message: 'hi' }],
  ): Promise<string> {
    const [{ id }] = await owner.query<Array<{ id: string }>>(
      `INSERT INTO workflows ("tenantId", name, steps, "createdAt")
       VALUES ($1, 'wf', $2::jsonb, $3::timestamptz) RETURNING id`,
      [tenantId, JSON.stringify(steps), createdAt],
    );
    return id;
  }

  async function walk(apiKey: string, limit: number): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let pages = 0; pages < 100; pages++) {
      const query = `?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await list(apiKey, query);
      expect(res.status).toBe(200);
      const page = (await res.json()) as Page;
      expect(page.items.length).toBeLessThanOrEqual(limit);
      ids.push(...page.items.map((w) => w.id));
      cursor = page.nextCursor;
      if (!cursor) return ids;
    }
    throw new Error('the cursor never ended');
  }

  it('walks every workflow once across pages with equal and microsecond-apart createdAt', async () => {
    const { tenant, apiKey } = await createTenant(owner);
    const expected: Array<{ id: string; at: string }> = [];
    // Сім із однаковим моментом, два — на 1 мкс раніше й пізніше, ще три — з різницею в мс.
    const same = '2026-03-01T10:00:00.000500Z';
    for (let i = 0; i < 7; i++)
      expected.push({ id: await insert(tenant.id, same), at: same });
    for (const at of [
      '2026-03-01T10:00:00.000499Z',
      '2026-03-01T10:00:00.000501Z',
      '2026-03-01T10:00:00.001Z',
      '2026-03-01T09:59:59.999Z',
      '2026-03-01T10:00:01Z',
    ])
      expected.push({ id: await insert(tenant.id, at), at });
    const order = await owner.query<Array<{ id: string }>>(
      `SELECT id FROM workflows WHERE "tenantId" = $1 ORDER BY "createdAt" DESC, id DESC`,
      [tenant.id],
    );
    for (const limit of [1, 2, 3, 5, 12, 100])
      expect(await walk(apiKey, limit)).toEqual(order.map((r) => r.id));
  });

  it('returns a last partial page without a cursor and an empty page for a tenant without workflows', async () => {
    const { tenant, apiKey } = await createTenant(owner);
    for (let i = 0; i < 5; i++)
      await insert(tenant.id, `2026-03-01T10:00:0${i}Z`);
    const first = (await (await list(apiKey, '?limit=3')).json()) as Page;
    expect(first.items).toHaveLength(3);
    expect(first.nextCursor).toEqual(expect.any(String));
    const last = (await (
      await list(
        apiKey,
        `?limit=3&cursor=${encodeURIComponent(first.nextCursor!)}`,
      )
    ).json()) as Page;
    expect(last.items).toHaveLength(2);
    expect(last.nextCursor).toBeNull();

    const empty = await createTenant(owner, 'empty');
    expect(await (await list(empty.apiKey)).json()).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it('lists only overview fields, never the steps', async () => {
    const { tenant, apiKey } = await createTenant(owner);
    await insert(tenant.id, '2026-03-01T10:00:00Z', [
      {
        id: 'call',
        type: 'http',
        url: 'https://example.com',
        headers: { Authorization: 'Bearer list-marker' },
      },
    ]);
    const res = await list(apiKey);
    const text = await res.text();
    expect(text).not.toContain('list-marker');
    const page = JSON.parse(text) as Page;
    expect(Object.keys(page.items[0]).sort()).toEqual(
      [
        'id',
        'name',
        'enabled',
        'cron',
        'timezone',
        'version',
        'missedRunPolicy',
        'nextFireAt',
        'scheduleBlockedSince',
        'scheduleError',
        'createdAt',
      ].sort(),
    );
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('answers with the same bytes whatever the size of the definitions', async () => {
    const small = await createTenant(owner, 'small');
    const large = await createTenant(owner, 'large');
    const bigStep = (i: number) => ({
      id: `s${i}`,
      type: 'log',
      message: 'x'.repeat(4000),
    });
    for (let i = 0; i < 30; i++) {
      const at = `2026-03-01T10:00:${String(i).padStart(2, '0')}Z`;
      await insert(small.tenant.id, at);
      await insert(
        large.tenant.id,
        at,
        Array.from({ length: 15 }, (_, s) => bigStep(s)),
      );
    }
    const strip = (text: string) =>
      text
        .replace(/"id":"[0-9a-f-]{36}"/g, '')
        .replace(/"nextCursor":"[^"]+"/, '');
    const a = await (await list(small.apiKey, '?limit=30')).text();
    const b = await (await list(large.apiKey, '?limit=30')).text();
    expect(Buffer.byteLength(strip(b))).toBe(Buffer.byteLength(strip(a)));
  });

  it('isolates tenants: the cursor of tenant A does not reveal workflows of tenant B', async () => {
    const a = await createTenant(owner, 'a');
    const b = await createTenant(owner, 'b');
    for (let i = 0; i < 3; i++) {
      await insert(a.tenant.id, `2026-03-01T10:00:0${i}Z`);
      await insert(b.tenant.id, `2026-03-01T10:00:0${i}Z`);
    }
    const pageA = (await (await list(a.apiKey, '?limit=1')).json()) as Page;
    const fromB = (await (
      await list(
        b.apiKey,
        `?limit=100&cursor=${encodeURIComponent(pageA.nextCursor!)}`,
      )
    ).json()) as Page;
    const idsOfB = await owner.query<Array<{ id: string }>>(
      `SELECT id FROM workflows WHERE "tenantId" = $1`,
      [b.tenant.id],
    );
    for (const item of fromB.items)
      expect(idsOfB.map((r) => r.id)).toContain(item.id);
    expect(await walk(a.apiKey, 2)).toHaveLength(3);
  });

  it.each([
    ['limit=abc'],
    ['limit=1.5'],
    ['limit=-1'],
    ['limit=0'],
    ['limit=101'],
    ['limit='],
    ['cursor=not-a-cursor'],
    // Правильна форма, неможлива дата (30 лютого).
    [
      `cursor=${Buffer.from('2026-02-30T10:00:00.000000Z|00000000-0000-4000-8000-000000000000|workflows').toString('base64url')}`,
    ],
    [`cursor=${'A'.repeat(300)}`],
    ['unknown=1'],
  ])('rejects %s with 400', async (query) => {
    const { apiKey } = await createTenant(owner);
    expect((await list(apiKey, `?${query}`)).status).toBe(400);
  });

  it('defaults to 50 workflows per page and accepts the upper bound of 100', async () => {
    const { tenant, apiKey } = await createTenant(owner);
    await owner.query(
      `INSERT INTO workflows ("tenantId", name, steps, "createdAt")
       SELECT $1, 'wf', '[]', '2026-03-01'::timestamptz + make_interval(secs => g)
         FROM generate_series(1, 120) g`,
      [tenant.id],
    );
    const byDefault = (await (await list(apiKey)).json()) as Page;
    expect(byDefault.items).toHaveLength(50);
    const max = (await (await list(apiKey, '?limit=100')).json()) as Page;
    expect(max.items).toHaveLength(100);
    expect(max.nextCursor).toEqual(expect.any(String));
  });
});
