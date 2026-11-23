import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { newTenant, session } from './fixtures';

test('keeps the committed run across a lost response, a real 429 and a draft edit', async ({
  context,
  page,
  request,
}) => {
  const tenant = await newTenant(request);
  await session(context, tenant.apiKey);
  const api = process.env.API_ORIGIN ?? 'http://localhost:3000';
  const changeLimit = async (rateLimit: number | null) => {
    const response = await request.patch(`${api}/tenants/${tenant.id}/limits`, {
      headers: { 'x-admin-token': process.env.ADMIN_TOKEN! },
      data: { rateLimit },
    });
    expect(response.status()).toBe(200);
  };
  await page.goto('/workflows/new');
  await page.getByLabel('Назва процесу').fill('Повтор запуску після обриву');
  await page.getByLabel('Повідомлення').fill('крок');
  await page.getByRole('button', { name: 'Зберегти процес' }).click();
  await expect(page).toHaveURL(/\/workflows\/[a-f0-9-]+$/);
  const workflowUrl = page.url();
  const workflowId = new URL(workflowUrl).pathname.split('/').pop();
  expect(workflowId).toMatch(/^[a-f0-9-]{36}$/);
  const executions = async () => {
    const response = await request.get(
      `${api}/executions?workflowId=${workflowId}`,
      {
        headers: { 'x-api-key': tenant.apiKey },
      },
    );
    expect(response.status()).toBe(200);
    return ((await response.json()) as { items: Array<{ id: string }> }).items;
  };
  const composeQuery = (sql: string) => {
    const project = process.env.COMPOSE_PROJECT_NAME;
    if (!project) return;
    return execFileSync(
      'docker',
      [
        'compose',
        '-p',
        project,
        'exec',
        '-T',
        'postgres',
        'psql',
        '-X',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        'flowforge',
        '-d',
        'flowforge',
        '-Atc',
        sql,
      ],
      { cwd: '../..', encoding: 'utf8', timeout: 5_000 },
    ).trim();
  };
  const expectRowCount = (count: number) => {
    const rows = composeQuery(
      `SELECT count(*) FROM executions WHERE "workflowId"='${workflowId}'`,
    );
    if (rows !== undefined) expect(rows).toBe(String(count));
  };
  const original = '{"number":42,"text":"original"}';
  const input = page.getByLabel('Вхідні дані (JSON)');
  const run = page.getByRole('button', {
    name: /^(Запустити|Повторити попередній запуск)$/,
  });
  const requests: Array<{ key: string; input: string | null }> = [];
  const acknowledgedIds: Array<string | undefined> = [];
  let firstId: string | undefined;
  await page.route('**/api/proxy/workflows/*/run', async (route) => {
    const sent = route.request();
    requests.push({
      key: sent.headers()['idempotency-key'],
      input: sent.postData(),
    });
    const upstream = await route.fetch();
    try {
      const id = upstream.ok()
        ? ((await upstream.json()) as { id: string }).id
        : undefined;
      acknowledgedIds.push(id);
      if (requests.length === 1) {
        expect(upstream.status()).toBe(201);
        firstId = id;
        await route.abort('connectionreset');
      } else {
        await route.fulfill({ response: upstream });
      }
    } finally {
      await upstream.dispose();
    }
  });
  const nextResponse = () =>
    page.waitForResponse((res) => res.url().endsWith('/run'));
  await input.fill(original);
  await run.click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText(
    'Результат запуску невідомий',
  );
  expect(firstId).toMatch(/^[a-f0-9-]{36}$/);
  expectRowCount(1);

  await changeLimit(1);
  try {
    // У Compose примусово завершуємо старе вікно. Звичайний GET займає нову квоту,
    // а перевірка залишку часу дозволяє цей самий тест запускати без доступу до БД.
    expect(tenant.id).toMatch(/^[a-f0-9-]{36}$/);
    const key = 'tenant:' + tenant.id;
    const previousWindow = composeQuery(
      `WITH expired AS (
        UPDATE rate_limit_buckets SET "resetAt"=clock_timestamp() - interval '1 second'
        WHERE key='${key}' RETURNING key
      ) SELECT key FROM expired`,
    );
    if (previousWindow !== undefined) expect(previousWindow).toBe(key);
    await expect
      .poll(
        async () => {
          const hit = await request.get(api + '/workflows?limit=1', {
            headers: { 'x-api-key': tenant.apiKey },
            timeout: 5_000,
          });
          try {
            expect([200, 429]).toContain(hit.status());
            expect(hit.headers()['x-ratelimit-limit']).toBe('1');
            expect(hit.headers()['x-ratelimit-remaining']).toBe('0');
            return Number(hit.headers()['x-ratelimit-reset']);
          } finally {
            await hit.dispose();
          }
        },
        { timeout: 12_000 },
      )
      .toBeGreaterThanOrEqual(5);
    const response = nextResponse();
    await run.click();
    const limited = await response;
    expect(limited.status()).toBe(429);
    expect(Number(limited.headers()['retry-after'])).toBeGreaterThan(0);
    expect(await limited.json()).toMatchObject({ error: 'rate_limited' });
    await expect(page.getByRole('main').getByRole('alert')).toContainText(
      'Забагато запитів',
    );
  } finally {
    await changeLimit(null);
  }
  await input.fill('{"text":"edited draft"}');
  const replay = nextResponse();
  await run.click();
  const response = await replay;
  expect(response.status()).toBe(200);
  expect(acknowledgedIds).toEqual([firstId, undefined, firstId]);
  await expect(page).toHaveURL(new RegExp(`/executions/${firstId}$`));
  expect(requests[0].key).toMatch(/^[a-f0-9-]{36}$/);
  expect(requests).toEqual(
    Array.from({ length: 3 }, () => ({
      key: requests[0].key,
      input: original,
    })),
  );
  expect((await executions()).map(({ id }) => id)).toEqual([firstId]);
  expectRowCount(1);

  await page.goto(workflowUrl);
  await input.fill(original);
  const nextRun = nextResponse();
  await page.getByRole('button', { name: 'Запустити', exact: true }).click();
  const created = await nextRun;
  expect(created.status()).toBe(201);
  const nextId = acknowledgedIds[3];
  expect(nextId).toMatch(/^[a-f0-9-]{36}$/);
  expect(nextId).not.toBe(firstId);
  expect(requests[3]).toMatchObject({ input: original });
  expect(requests[3].key).not.toBe(requests[0].key);
  expect((await executions()).map(({ id }) => id).sort()).toEqual(
    [firstId, nextId].sort(),
  );
  expectRowCount(2);
});
