import { DataSource } from 'typeorm';
import { TenantDb } from '../../src/tenancy/tenant-db';
import { WebhookKeysService } from '../../src/webhooks/webhook-keys.service';
import { RunningApp, startApp } from '../helpers/app';
import { createWorkflow, openTestDataSource, truncateAll } from '../helpers/db';
import {
  createTenantViaApi,
  newSecret,
  tenantBody,
} from '../helpers/credentials';
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

  const newTenant = () => createTenantViaApi(running.baseUrl, 'keys');
  const keys = (apiKey: string, method = 'GET', suffix = '', secret?: string) =>
    fetch(running.baseUrl + '/tenants/me/webhook-secrets' + suffix, {
      method,
      headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
      body:
        method === 'POST'
          ? JSON.stringify({ secret: secret ?? newSecret() })
          : undefined,
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
      await service.rotateIn(em, tenant.id, newSecret());
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

  it('accepts only client-generated keys and replays a lost rotation response', async () => {
    const tenant = await newTenant();
    // Слабкі значення відхиляються без відлуння в повідомленні.
    for (const secret of [
      'short',
      'a'.repeat(64),
      'ab'.repeat(32),
      ' '.repeat(40),
    ]) {
      const res = await keys(tenant.apiKey, 'POST', '', secret);
      expect(res.status).toBe(400);
      expect(await res.text()).not.toContain(secret.trim() || '    ');
    }
    // Той самий секрет, що й чинний, ключем не стає.
    expect(
      (await keys(tenant.apiKey, 'POST', '', tenant.webhookSecret)).status,
    ).toBe(409);
    const secret = newSecret();
    const first = await keys(tenant.apiKey, 'POST', '', secret);
    expect(first.status).toBe(201);
    const created = (await first.json()) as Record<string, unknown>;
    expect(created).toEqual({
      id: expect.any(String) as unknown,
      role: 'next',
    });
    // Відповідь втрачено — повтор із тим самим секретом повертає той самий ключ.
    const replay = await keys(tenant.apiKey, 'POST', '', secret);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(created);
    expect((await keys(tenant.apiKey, 'POST', '', newSecret())).status).toBe(
      409,
    );
  });

  it('creates a tenant from operator credentials and replays the same request', async () => {
    const body = tenantBody('replayed');
    const post = (payload: unknown) =>
      fetch(running.baseUrl + '/tenants', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-admin-token': TEST_ADMIN_TOKEN,
        },
        body: JSON.stringify(payload),
      });
    const results = await Promise.all([post(body), post(body)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 201]);
    const [a, b] = (await Promise.all(results.map((r) => r.json()))) as Array<
      Record<string, unknown>
    >;
    expect(a).toEqual(b);
    expect(Object.keys(a).sort()).toEqual([
      'id',
      'limits',
      'name',
      'webhookKeyId',
    ]);
    expect((await post({ ...body, name: 'other' })).status).toBe(409);
    expect((await post({ ...body, webhookSecret: newSecret() })).status).toBe(
      409,
    );
    for (const apiKey of ['ff_short', 'x'.repeat(64), 'ff_' + 'ab'.repeat(30)])
      expect((await post({ ...tenantBody('weak'), apiKey })).status).toBe(400);
    expect((await post({ name: 'missing' })).status).toBe(400);
    const [{ count }]: Array<{ count: string }> = await ds.query(
      'SELECT count(*) FROM tenants',
    );
    expect(Number(count)).toBe(1);
    // Ключ із тіла запиту автентифікує тенанта.
    expect((await keys(body.apiKey)).status).toBe(200);
  });
});
