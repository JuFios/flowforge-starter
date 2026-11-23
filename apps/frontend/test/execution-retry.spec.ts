import { expect, test } from '@playwright/test';
import { newTenant, session } from './fixtures';

test('reuses the original failed cycle until the user explicitly retries the newer one', async ({
  context,
  page,
  request,
}) => {
  const tenant = await newTenant(request);
  await session(context, tenant.apiKey);
  const api = process.env.API_ORIGIN ?? 'http://localhost:3000';
  const headers = { 'x-api-key': tenant.apiKey };
  const workflow = await request.post(api + '/workflows', {
    headers,
    data: {
      name: 'Помилка перетворення',
      steps: [
        { id: 'shape', type: 'transform', expr: '[input.data, input.data]' },
      ],
    },
  });
  expect(workflow.status()).toBe(201);
  const { id: workflowId } = (await workflow.json()) as { id: string };
  // Вхід вкладається в ліміт запуску, а детермінований результат перевищує ліміт кроку.
  const run = await request.post(api + '/workflows/' + workflowId + '/run', {
    headers,
    data: { data: 'x'.repeat(34_000) },
  });
  expect(run.status()).toBe(201);
  const { id } = (await run.json()) as { id: string };
  const summary = async () => {
    const response = await request.get(api + '/executions/' + id + '/summary', {
      headers,
    });
    expect(response.status()).toBe(200);
    return (await response.json()) as {
      terminalCycles: number;
      status: string;
    };
  };
  await expect
    .poll(summary)
    .toMatchObject({ status: 'failed', terminalCycles: 1 });

  const retryPath = /\/api\/proxy\/executions\/[^/]+\/retry(?:\?|$)/;
  const sentCycles: Array<string | null> = [];
  await page.route(retryPath, async (route) => {
    sentCycles.push(
      new URL(route.request().url()).searchParams.get('expectedTerminalCycle'),
    );
    if (sentCycles.length > 1) return route.continue();
    const committed = await route.fetch();
    try {
      expect(committed.status()).toBe(202);
    } finally {
      await committed.dispose();
      await route.abort('connectionreset');
    }
  });
  await page.goto('/executions/' + id);
  const retry = page.getByRole('button', {
    name: 'Повторити виконання',
    exact: true,
  });
  await retry.click();
  await expect(page.getByText(/Результат повтору невідомий/)).toBeVisible();
  await expect
    .poll(summary)
    .toMatchObject({ status: 'failed', terminalCycles: 2 });

  const replay = page.waitForResponse((result) => retryPath.test(result.url()));
  await page
    .getByRole('button', { name: 'Повторити попередній запит', exact: true })
    .click();
  expect((await replay).status()).toBe(409);
  await expect(
    page.getByText(/Цей термінальний цикл уже змінився/),
  ).toBeVisible();
  expect(sentCycles).toEqual(['1', '1']);
  expect(await summary()).toMatchObject({
    status: 'failed',
    terminalCycles: 2,
  });

  const explicit = page.waitForResponse((result) =>
    retryPath.test(result.url()),
  );
  await retry.click();
  expect((await explicit).status()).toBe(202);
  expect(sentCycles).toEqual(['1', '1', '2']);
  await expect
    .poll(summary)
    .toMatchObject({ status: 'failed', terminalCycles: 3 });
});
