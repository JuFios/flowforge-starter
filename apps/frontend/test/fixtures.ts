import {
  expect,
  type APIRequestContext,
  type BrowserContext,
} from '@playwright/test';
const api = process.env.API_ORIGIN ?? 'http://localhost:3000';
export async function newTenant(request: APIRequestContext) {
  const token = process.env.ADMIN_TOKEN;
  if (!token)
    throw new Error('ADMIN_TOKEN потрібен для створення тестового тенанта');
  const response = await request.post(api + '/tenants', {
    headers: { 'x-admin-token': token },
    data: { name: 'browser acceptance' },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as { id: string; apiKey: string };
}
export async function session(context: BrowserContext, key: string) {
  const origin = process.env.FRONTEND_ORIGIN ?? 'http://localhost:3001';
  const response = await context.request.post(origin + '/api/session', {
    headers: { origin },
    data: { apiKey: key },
  });
  expect(response.status()).toBe(201);
}
export async function createRun(request: APIRequestContext, key: string) {
  const headers = { 'x-api-key': key };
  const wf = await request.post(api + '/workflows', {
    headers,
    data: {
      name: 'subscription lifecycle',
      steps: [{ id: 'write', type: 'log', message: 'complete' }],
    },
  });
  expect(wf.status()).toBe(201);
  const { id } = (await wf.json()) as { id: string };
  const run = await request.post(api + '/workflows/' + id + '/run', {
    headers,
    data: {},
  });
  expect(run.status()).toBe(201);
  return ((await run.json()) as { id: string }).id;
}
