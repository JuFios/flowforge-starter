import { expect, test } from '@playwright/test';
import { createRun, newTenant, session } from './fixtures';

test('leaving an execution releases its socket and stops polling', async ({
  page,
  context,
  request,
}) => {
  const { apiKey } = await newTenant(request);
  const id = await createRun(request, apiKey);
  const origin = process.env.FRONTEND_ORIGIN ?? 'http://localhost:3001';
  // Стартовий клієнт і поточний мають різні контракти входу.
  if (process.env.BASELINE_FRONTEND === '1')
    await context.addCookies([
      { name: 'ff_api_key', value: apiKey, url: origin },
    ]);
  else await session(context, apiKey);
  let polling = 0;
  const open = new Set();
  page.on('websocket', (ws) => {
    if (new URL(ws.url()).pathname === '/realtime') {
      open.add(ws);
      ws.on('close', () => open.delete(ws));
    }
  });
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/proxy/executions/' + id) polling++;
  });
  await page.goto('/executions/' + id);
  await expect.poll(() => open.size + polling).toBeGreaterThan(0);
  for (let visit = 0; visit < 3; visit++) {
    // Link робить клієнтську навігацію; повне перезавантаження приховало б витік.
    await page.locator('nav a[href="/workflows"]').click();
    await expect(page).toHaveURL(/\/workflows$/);
    await expect.poll(() => open.size).toBe(0);
    const atUnmount = polling;
    await page.waitForTimeout(1300);
    expect(polling, 'previous execution continued polling after unmount').toBe(
      atUnmount,
    );
    if (visit < 2) {
      await page.goBack();
      await expect
        .poll(() => open.size + polling - atUnmount)
        .toBeGreaterThan(0);
    }
  }
});
