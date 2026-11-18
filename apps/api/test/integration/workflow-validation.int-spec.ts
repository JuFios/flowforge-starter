import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { RunningApp, startApp } from '../helpers/app';
import { createTenant, openTestDataSource, truncateAll } from '../helpers/db';
import { api } from '../helpers/queue';

/** Вхід тенанта перевіряється на межі API: невалідне — 400 з поясненням, а не 500 чи збереження. */
describe('workflow and run input is validated at the API boundary', () => {
  let ds: DataSource;
  let app: RunningApp;
  let apiKey: string;
  const steps = [{ id: 'say', type: 'log', message: 'hi' }];

  beforeAll(async () => {
    ds = await openTestDataSource();
    app = await startApp(AppModule);
  });

  beforeEach(async () => {
    await truncateAll(ds);
    ({ apiKey } = await createTenant(ds));
  });

  afterAll(async () => {
    await app.close();
    await ds.destroy();
  });

  const call = (method: string, path: string, body?: unknown) =>
    api<{ message?: unknown }>(app.baseUrl, apiKey, method, path, body);

  it.each([
    ['without a name', { steps }],
    ['with an empty name', { name: '', steps }],
    ['with an overly long name', { name: 'n'.repeat(201), steps }],
    ['with a non-string name', { name: 42, steps }],
    ['with a non-boolean enabled flag', { name: 'w', steps, enabled: 'yes' }],
    [
      'with an overly long cron expression',
      { name: 'w', steps, cron: '*'.repeat(101) },
    ],
    ['with an unknown field', { name: 'w', steps, owner: 'other-tenant' }],
  ])('rejects creating a workflow %s with 400', async (_case, body) => {
    const res = await call('POST', '/workflows', body);
    expect(res.status).toBe(400);
    expect(await ds.query(`SELECT 1 FROM workflows`)).toHaveLength(0);
  });

  it('rejects an invalid update with 400 and keeps the workflow unchanged', async () => {
    const created = await call('POST', '/workflows', { name: 'w', steps });
    expect(created.status).toBe(201);
    const id = (created.body as unknown as { id: string }).id;

    const res = await call('PATCH', `/workflows/${id}`, { name: 7 });
    expect(res.status).toBe(400);
    const [row]: Array<{ name: string }> = await ds.query(
      `SELECT name FROM workflows WHERE id = $1`,
      [id],
    );
    expect(row.name).toBe('w');
  });

  it.each(['name', 'timezone', 'enabled', 'steps'])(
    'rejects a null %s on PATCH and allows clearing cron',
    async (field) => {
      const created = await api<{ id: string }>(
        app.baseUrl,
        apiKey,
        'POST',
        '/workflows',
        { name: 'w', steps, cron: '0 * * * *' },
      );
      const path = `/workflows/${created.body.id}`;
      expect((await call('PATCH', path, { [field]: null })).status).toBe(400);
      const cleared = await call('PATCH', path, { cron: null });
      expect(cleared.status).toBe(200);
      expect(cleared.body).toMatchObject({ name: 'w', steps, cron: null });
    },
  );

  it('preserves valid header names in the workflow and its version', async () => {
    const headers = Object.fromEntries([
      ['__proto__', 'tenant'],
      ['constructor', 'custom'],
    ]);
    const steps = [
      { id: 'call', type: 'http', url: 'https://example.com', headers },
    ];
    const wf = await api<{ id: string }>(
      app.baseUrl,
      apiKey,
      'POST',
      '/workflows',
      { name: 'headers', steps },
    );
    expect(wf.status).toBe(201);
    const rows: { steps: unknown }[] = await ds.query(
      'SELECT steps FROM workflow_versions WHERE "workflowId" = $1 UNION ALL SELECT steps FROM workflows WHERE id = $1',
      [wf.body.id],
    );
    expect(rows).toEqual([{ steps }, { steps }]);
  });

  it.each([
    ['an array', [1, 2]],
    ['a string', 'text'],
  ])('rejects a run whose input is %s with 400', async (_case, input) => {
    const created = await call('POST', '/workflows', { name: 'w', steps });
    const id = (created.body as unknown as { id: string }).id;
    const res = await call('POST', `/workflows/${id}/run`, input);
    expect(res.status).toBe(400);
    expect(await ds.query(`SELECT 1 FROM executions`)).toHaveLength(0);
  });

  it('rejects a run whose input is larger than 64 KiB with 400', async () => {
    const created = await call('POST', '/workflows', { name: 'w', steps });
    const id = (created.body as unknown as { id: string }).id;
    const res = await call('POST', `/workflows/${id}/run`, {
      blob: 'x'.repeat(64 * 1024),
    });
    expect(res.status).toBe(400);
  });
});
