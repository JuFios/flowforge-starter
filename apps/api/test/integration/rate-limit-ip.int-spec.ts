import { createHmac } from 'node:crypto';
import { DataSource } from 'typeorm';
import type { RunningApp } from '../helpers/app';
import { createTenant, openTestDataSource, truncateAll } from '../helpers/db';
import { TEST_ADMIN_TOKEN } from '../helpers/test-env';
import { newCredentials } from '../helpers/credentials';

/**
 * Ліміти за IP-адресою клієнта: кожен запит до `/tenants…` (перебір адмін-токена) і невдалі
 * автентифікації (невірний ключ чи підпис; успішні не рахуються). IP — з X-Forwarded-For лише за
 * довіреним проксі (TRUST_PROXY).
 *
 * Конфігурація читається під час імпорту модуля застосунку, тож кожен варіант оточення — в
 * ізольованому реєстрі модулів.
 */
async function startWith(env: Record<string, string>): Promise<RunningApp> {
  const saved = Object.fromEntries(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, env);
  try {
    let app: RunningApp | undefined;
    await jest.isolateModulesAsync(async () => {
      const { startApp } = await import('../helpers/app');
      app = await startApp();
    });
    return app!;
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('limits by client IP', () => {
  let owner: DataSource;
  let api: RunningApp;
  let proxied: RunningApp;

  beforeAll(async () => {
    owner = await openTestDataSource();
    api = await startWith({
      ADMIN_RATE_LIMIT: '3',
      AUTH_FAILURE_RATE_LIMIT: '3',
      TRUST_PROXY: 'false',
    });
    proxied = await startWith({ ADMIN_RATE_LIMIT: '2', TRUST_PROXY: '1' });
  });

  beforeEach(() => truncateAll(owner));

  afterAll(async () => {
    await api.close();
    await proxied.close();
    await truncateAll(owner);
    await owner.destroy();
  });

  const createTenantRequest = (
    app: RunningApp,
    token: string,
    headers: Record<string, string> = {},
  ) =>
    fetch(`${app.baseUrl}/tenants`, {
      method: 'POST',
      headers: {
        'x-admin-token': token,
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify({ name: 'by-ip', ...newCredentials() }),
    });

  it('counts every admin request from an IP before checking the token', async () => {
    expect((await createTenantRequest(api, TEST_ADMIN_TOKEN)).status).toBe(201);
    expect((await createTenantRequest(api, 'wrong-token-0000')).status).toBe(
      403,
    );
    const third = await createTenantRequest(api, TEST_ADMIN_TOKEN);
    expect(third.status).toBe(201);
    expect(third.headers.get('x-ratelimit-remaining')).toBe('0');
    // Понад ліміт — 429 навіть із правильним токеном; X-Forwarded-For без довіреного проксі
    // нічого не змінює.
    const fourth = await createTenantRequest(api, TEST_ADMIN_TOKEN, {
      'x-forwarded-for': '203.0.113.9',
    });
    expect(fourth.status).toBe(429);
    expect(await fourth.json()).toMatchObject({ error: 'rate_limited' });
    expect(Number(fourth.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  // Невідомий адресат webhook-а — та сама невдала автентифікація: інакше перебір випадкових UUID
  // без жодного ліміту навантажував би БД пошуком тенанта.
  it('counts webhooks to an unknown workflow as failed authentications', async () => {
    const hook = () =>
      fetch(`${api.baseUrl}/hooks/${crypto.randomUUID()}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-signature': 'x' },
        body: '{}',
      });
    const first = await hook();
    expect(first.status).toBe(404);
    expect(first.headers.get('x-ratelimit-remaining')).toBe('2');
    expect((await hook()).status).toBe(404);
    expect((await hook()).status).toBe(404);
    const blocked = await hook();
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({ error: 'rate_limited' });
  });

  it('answers 429 instead of 401 past the limit of failed authentications and lets valid keys through', async () => {
    const { apiKey } = await createTenant(owner);
    const wf = await fetch(`${api.baseUrl}/workflows`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'w',
        steps: [{ id: 'say', type: 'log', message: 'hi' }],
      }),
    });
    const wfId = ((await wf.json()) as { id: string }).id;
    const badKey = () =>
      fetch(`${api.baseUrl}/workflows`, {
        headers: { 'x-api-key': 'ff_not-a-key' },
      });
    const first = await badKey();
    expect(first.status).toBe(401);
    expect(first.headers.get('x-ratelimit-limit')).toBe('3');
    expect(first.headers.get('x-ratelimit-remaining')).toBe('2');
    expect((await fetch(`${api.baseUrl}/workflows`)).status).toBe(401);
    // Невірний підпис webhook-а — та сама квота невдач.
    const body = JSON.stringify({ n: 1 });
    const badHook = await fetch(`${api.baseUrl}/hooks/${wfId}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signature': createHmac('sha256', 'wrong').update(body).digest('hex'),
      },
      body,
    });
    expect(badHook.status).toBe(401);
    const blocked = await badKey();
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({ error: 'rate_limited' });
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    // Успішна автентифікація цим лімітом не обмежується й не рахується.
    for (let i = 0; i < 3; i++)
      expect(
        (
          await fetch(`${api.baseUrl}/workflows`, {
            headers: { 'x-api-key': apiKey },
          })
        ).status,
      ).toBe(200);
  });

  it('takes the client IP from X-Forwarded-For behind a trusted proxy', async () => {
    const from = (ip: string) =>
      createTenantRequest(proxied, TEST_ADMIN_TOKEN, { 'x-forwarded-for': ip });
    expect((await from('198.51.100.1')).status).toBe(201);
    expect((await from('198.51.100.1')).status).toBe(201);
    expect((await from('198.51.100.1')).status).toBe(429);
    expect((await from('198.51.100.2')).status).toBe(201);
  });
});
