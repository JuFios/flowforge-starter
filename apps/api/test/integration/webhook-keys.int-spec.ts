import { DataSource } from 'typeorm';
import { TenantDb } from '../../src/tenancy/tenant-db';
import { WebhookKeysService } from '../../src/webhooks/webhook-keys.service';
import { RunningApp, startApp } from '../helpers/app';
import { createWorkflow, openTestDataSource, truncateAll } from '../helpers/db';
import { TEST_ADMIN_TOKEN } from '../helpers/test-env';

/** Керування ключами підпису (README 3.3.7, «Ротація без простою»). */
describe('webhook key management', () => {
  let ds: DataSource;
  let running: RunningApp;

  beforeAll(async () => {
    ds = await openTestDataSource();
    running = await startApp();
  });
  beforeEach(() => truncateAll(ds));
  afterAll(async () => {
    await running.close();
    await ds.destroy();
  });

  async function newTenant() {
    const res = await fetch(running.baseUrl + '/tenants', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-token': TEST_ADMIN_TOKEN,
      },
      body: JSON.stringify({ name: 'keys' }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as {
      id: string;
      apiKey: string;
      webhookKeyId: string;
    };
  }
  const keys = (apiKey: string, method = 'GET', suffix = '') =>
    fetch(running.baseUrl + '/tenants/me/webhook-secrets' + suffix, {
      method,
      headers: { 'x-api-key': apiKey },
    });

  it('names the current and the next key so a lost rotation can be undone', async () => {
    const tenant = await newTenant();
    expect(await (await keys(tenant.apiKey)).json()).toEqual([
      { id: tenant.webhookKeyId, role: 'current' },
    ]);
    // Відповідь ротації втрачено: власник знаходить новий ключ за роллю і відкликає саме його.
    expect((await keys(tenant.apiKey, 'POST')).status).toBe(201);
    const listed = (await (await keys(tenant.apiKey)).json()) as Array<{
      id: string;
      role: string;
    }>;
    expect(listed).toEqual([
      { id: tenant.webhookKeyId, role: 'current' },
      { id: expect.any(String) as string, role: 'next' },
    ]);
    const next = listed[1].id;
    expect((await keys(tenant.apiKey, 'DELETE', '/' + next)).status).toBe(204);
    expect(await (await keys(tenant.apiKey)).json()).toEqual([
      { id: tenant.webhookKeyId, role: 'current' },
    ]);
    // Після відкликання поточного ключа наступний стає поточним.
    const rotated = (await (await keys(tenant.apiKey, 'POST')).json()) as {
      id: string;
    };
    expect(
      (await keys(tenant.apiKey, 'DELETE', '/' + tenant.webhookKeyId)).status,
    ).toBe(204);
    expect(await (await keys(tenant.apiKey)).json()).toEqual([
      { id: rotated.id, role: 'current' },
    ]);
  });

  it('does not hold up other enqueues of the tenant while a rotation is uncommitted', async () => {
    const tenant = await newTenant();
    const workflow = await createWorkflow(ds, tenant.id);
    const service = running.app.get(WebhookKeysService);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const rowLocked = new Promise<void>((resolve) => (locked = resolve));
    const rotation = running.app.get(TenantDb).run(tenant.id, async (em) => {
      await service.rotateIn(em, tenant.id);
      locked();
      await held;
    });
    try {
      await rowLocked;
      // Вставка виконання бере FOR KEY SHARE на рядок тенанта (зовнішній ключ); FOR UPDATE ротації
      // заблокував би її до COMMIT.
      const run = await fetch(
        `${running.baseUrl}/workflows/${workflow.id}/run`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': tenant.apiKey,
          },
          body: '{}',
          signal: AbortSignal.timeout(5000),
        },
      );
      expect(run.status).toBe(201);
    } finally {
      release();
      await rotation;
    }
  });
});
