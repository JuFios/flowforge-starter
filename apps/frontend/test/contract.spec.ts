import { expect, test } from '@playwright/test';
import { createWorkflowSchema } from '../lib/workflow-schema';
import { newTenant, session } from './fixtures';

test('the form and API agree on bounded steps and schedule fields', async ({
  request,
}) => {
  const { apiKey } = await newTenant(request);
  const url =
    (process.env.API_ORIGIN ?? 'http://localhost:3000') + '/workflows';
  const headers = { 'x-api-key': apiKey };
  const step = { id: 'note', type: 'log', message: 'Перевірка' };
  for (const [valid, fields] of [
    [
      true,
      {
        cron: '0 9 * * *',
        timezone: 'Europe/Kyiv',
        missedRunPolicy: 'run_once',
      },
    ],
    [true, { steps: [{ id: 'x', type: 'transform', expr: 'ctx.input' }] }],
    [true, { steps: [{ id: 'x', type: 'delay', ms: 0 }] }],
    [
      true,
      {
        steps: [
          {
            id: 'get',
            type: 'http',
            url: 'https://example.com',
            headers: { 'X-Tag': '' },
          },
        ],
      },
    ],
    [false, { steps: [{ ...step, id: 'invalid ID' }] }],
    [false, { steps: [step, step] }],
    [
      false,
      {
        steps: Array.from({ length: 51 }, (_, i) => ({ ...step, id: 's' + i })),
      },
    ],
    [
      false,
      {
        steps: [
          {
            id: 'get',
            type: 'http',
            url: 'https://example.com',
            headers: { 'X-Tag': { keep: true } },
          },
        ],
      },
    ],
    [false, { cron: '80 9 * * *' }],
    [false, { timezone: 'invalid/zone' }],
    [false, { missedRunPolicy: 'all' }],
  ] as const) {
    const data = { name: 'contract', steps: [step], ...fields };
    expect(createWorkflowSchema.safeParse(data).success).toBe(valid);
    expect((await request.post(url, { headers, data })).status()).toBe(
      valid ? 201 : 400,
    );
  }
});
test('preserves correlation and rate headers when a revoked session gets a 401', async ({
  request,
  context,
}) => {
  const tenant = await newTenant(request);
  await session(context, tenant.apiKey);
  const token = (await context.cookies()).find((cookie) =>
    ['ff_session', '__Host-ff_session'].includes(cookie.name),
  );
  expect(token).toBeDefined();
  const apiOrigin = process.env.API_ORIGIN ?? 'http://localhost:3000';
  const revoked = await request.delete(apiOrigin + '/sessions/current', {
    headers: { authorization: 'Bearer ' + token!.value },
  });
  expect(revoked.status()).toBe(204);

  const rejected = await context.request.get('/api/proxy/workflows');
  expect(rejected.status()).toBe(401);
  expect(await rejected.json()).toMatchObject({ error: 'session_expired' });
  expect(rejected.headers()).toMatchObject({
    'cache-control': 'private, no-store',
    'x-request-id': expect.any(String),
    'x-ratelimit-limit': expect.stringMatching(/^\d+$/),
    'x-ratelimit-remaining': expect.stringMatching(/^\d+$/),
    'x-ratelimit-reset': expect.stringMatching(/^\d+$/),
  });
  expect(
    (await context.cookies()).some((cookie) => cookie.name === token!.name),
  ).toBe(false);
});
