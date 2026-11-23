import { expect, test } from '@playwright/test';
import type { ExecutionListItem } from '../lib/types';
import { newTenant, session } from './fixtures';

test('resumes an interrupted page and keeps loaded executions distinguishable after reconnecting', async ({
  context,
  page,
  request,
}) => {
  const tenant = await newTenant(request);
  await session(context, tenant.apiKey);
  const executions = Array.from(
    { length: 35 },
    (_, index): ExecutionListItem => ({
      id: `${(0x10000000 + index).toString(16)}-0000-4000-8000-000000000000`,
      workflowId: '07150f56-4000-4000-8000-000000000000',
      workflowName: 'Щоденне зведення',
      workflowVersion: 1,
      status: 'succeeded',
      trigger: 'api',
      error: null,
      createdAt: '2026-11-20T15:08:05.000Z',
      finishedAt: '2026-11-20T15:08:06.000Z',
      scheduledAt: null,
      correlationId: null,
    }),
  );
  const cursors: Array<string | null> = [];
  let interrupted = false;
  const endpoint = '**/api/proxy/executions?*';
  await page.route(endpoint, async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    cursors.push(cursor);
    if (cursor === 'next-page' && !interrupted) {
      interrupted = true;
      await route.abort('internetdisconnected');
      return;
    }
    await route.fulfill({
      json: cursor
        ? { items: executions.slice(30), nextCursor: null }
        : { items: executions.slice(0, 30), nextCursor: 'next-page' },
    });
  });

  await page.goto('/executions');
  const rows = page.locator('tbody tr');
  await expect(rows).toHaveCount(30);
  await expect(rows.nth(0)).toContainText('10000000');
  await expect(rows.nth(1)).toContainText('10000001');
  const initialReads = cursors.length;
  await page.getByRole('button', { name: 'Завантажити ще' }).click();
  await expect(page.getByRole('button', { name: 'Повторити' })).toBeVisible();

  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(rows).toHaveCount(35);
  expect(cursors.slice(initialReads)).toEqual(['next-page', 'next-page']);

  await Promise.all([
    expect(page.waitForRequest(endpoint, { timeout: 750 })).rejects.toThrow(
      /Timeout/,
    ),
    page.evaluate(() => window.dispatchEvent(new Event('online'))),
  ]);
  await expect(rows).toHaveCount(35);
  await page.setViewportSize({ width: 360, height: 780 });
  await expect(
    rows.nth(0).getByText('10000000', { exact: true }),
  ).toBeVisible();
});

test('starts the list over when the API no longer accepts a cursor', async ({
  context,
  page,
  request,
}) => {
  const tenant = await newTenant(request);
  await session(context, tenant.apiKey);
  const executions = Array.from(
    { length: 31 },
    (_, index): ExecutionListItem => ({
      id: `${(0x20000000 + index).toString(16)}-0000-4000-8000-000000000000`,
      workflowId: '07150f56-4000-4000-8000-000000000000',
      workflowName: 'Щоденне зведення',
      workflowVersion: 1,
      status: 'succeeded',
      trigger: 'api',
      error: null,
      createdAt: '2026-11-20T15:08:05.000Z',
      finishedAt: '2026-11-20T15:08:06.000Z',
      scheduledAt: null,
      correlationId: null,
    }),
  );
  const cursors: Array<string | null> = [];
  await page.route('**/api/proxy/executions?*', async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    cursors.push(cursor);
    // Курсор, виданий до оновлення API: нова версія відповідає 400.
    if (cursor === 'issued-before-upgrade') {
      await route.fulfill({
        status: 400,
        json: {
          statusCode: 400,
          error: 'Bad Request',
          message: ['cursor does not match the filter'],
        },
      });
      return;
    }
    await route.fulfill({
      json: {
        items: executions.slice(0, 30),
        nextCursor: 'issued-before-upgrade',
      },
    });
  });

  await page.goto('/executions');
  const rows = page.locator('tbody tr');
  await expect(rows).toHaveCount(30);
  await page.getByRole('button', { name: 'Завантажити ще' }).click();
  await expect
    .poll(() => cursors)
    .toEqual([null, 'issued-before-upgrade', null]);
  await expect(rows).toHaveCount(30);
  await expect(page.getByRole('button', { name: 'Повторити' })).toHaveCount(0);
  await expect(
    page.getByRole('status').filter({ hasText: 'з першої сторінки' }),
  ).toBeVisible();
  await expect(rows.nth(0)).toContainText('20000000');
});
