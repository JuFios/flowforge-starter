import { expect, test } from '@playwright/test';
import { createRun, newTenant, session } from './fixtures';

test('the execution page waits for Retry-After before polling again and stops on navigation', async ({
  page,
  context,
  request,
}) => {
  const { apiKey } = await newTenant(request);
  const id = await createRun(request, apiKey);
  await session(context, apiKey);
  await page.clock.install({ time: new Date('2026-11-22T12:00:00Z') });
  await page.clock.pauseAt(new Date('2026-11-22T12:00:01Z'));
  let tickets = 0;
  await page.route(
    `**/api/proxy/executions/${id}/realtime-tickets`,
    (route) => {
      tickets++;
      return route.fulfill({ status: 503, json: { message: 'temporary' } });
    },
  );
  let requests = 0;
  await page.route(`**/api/proxy/executions/${id}/summary`, async (route) => {
    requests++;
    if (requests === 1) return route.continue();
    await route.fulfill({
      status: 429,
      headers: { 'Retry-After': '60' },
      json: {},
    });
  });
  const limited = page.waitForResponse(
    (res) =>
      res.url().endsWith(`/executions/${id}/summary`) && res.status() === 429,
  );
  await page.goto(`/executions/${id}`);
  await expect(
    page.getByRole('heading', { name: 'subscription lifecycle' }),
  ).toBeVisible();
  await expect.poll(() => requests).toBe(1);
  await expect.poll(() => tickets).toBe(1);
  for (const expected of [2, 3]) {
    for (let step = 0; tickets < expected && step < 10; step++) {
      await page.clock.runFor(1_000);
      await page.waitForTimeout(25);
    }
    await expect.poll(() => tickets).toBe(expected);
  }
  await expect(page.getByText('Оновлення через HTTP')).toBeVisible();
  await page.clock.runFor(2_000);
  await (await limited).finished();
  await expect.poll(() => requests).toBe(2);
  await page.clock.runFor(50_000);
  expect(requests).toBe(2);
  await page.clock.runFor(13_000);
  await expect.poll(() => requests).toBe(3);
  await page.clock.resume();
  await page.locator('nav a[href="/workflows"]').click();
  await expect(page).toHaveURL(/\/workflows$/);
  await page.clock.runFor(65_000);
  expect(requests).toBe(3);
});
