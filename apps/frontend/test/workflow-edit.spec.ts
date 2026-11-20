import { expect, test } from '@playwright/test';
import { newTenant, session } from './fixtures';

test('workflow edits retain the saved definition across tabs and can be cancelled', async ({
  context,
  page,
  request,
}) => {
  const tenant = await newTenant(request);
  await session(context, tenant.apiKey);
  await page.goto('/workflows/new');
  await page.getByLabel('Назва процесу').fill('Редагування');
  await page.getByLabel('Повідомлення').fill('Збережений крок');
  await page.getByRole('button', { name: 'Зберегти процес' }).click();
  await expect(page).toHaveURL(/\/workflows\/[a-f0-9-]+$/);
  const url = page.url();
  const older = await context.newPage();
  await older.goto(url);
  await older.getByRole('button', { name: 'Редагувати' }).click();
  await older.getByLabel('Назва процесу').fill('Чернетка');

  await page.getByRole('button', { name: 'Редагувати' }).click();
  await page.getByLabel('Назва процесу').fill('Оновлений процес');
  await page.getByRole('button', { name: 'Зберегти процес' }).click();
  await expect(
    page.getByRole('heading', { name: 'Оновлений процес' }),
  ).toBeVisible();
  await older.getByRole('button', { name: 'Зберегти процес' }).click();
  await expect(older.getByRole('main').getByRole('alert')).toContainText(
    'Процес уже змінено',
  );
  await expect(older.getByLabel('Назва процесу')).toHaveValue('Чернетка');
  await expect(
    older.getByRole('button', { name: 'Завантажити актуальну версію' }),
  ).toBeVisible();
  await older.getByRole('button', { name: 'Скасувати' }).click();
  await expect(older.getByRole('button', { name: 'Редагувати' })).toBeFocused();
  await expect(older.getByRole('button', { name: 'Запустити' })).toBeVisible();
  await expect(
    older.getByRole('heading', { name: 'Оновлений процес' }),
  ).toBeVisible();
  await older.close();

  await page.setViewportSize({ width: 360, height: 780 });
  await expect(
    page.getByRole('heading', { name: 'Оновлений процес' }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    360,
  );
});

test('keeps a body draft across method changes and sends run input numbers unchanged', async ({
  context,
  page,
  request,
}) => {
  const tenant = await newTenant(request);
  await session(context, tenant.apiKey);
  await page.goto('/workflows/new');
  await page.getByLabel('Назва процесу').fill('HTTP-метод');
  await page.getByLabel('Тип кроку').selectOption('http');
  await page.getByLabel('URL запиту').fill('https://example.com/data');
  await page.getByLabel('Метод').selectOption('POST');
  await page.getByLabel('Тіло HTTP-запиту').fill('draft');
  await page.getByLabel('Метод').selectOption('HEAD');
  await expect(page.getByLabel('Тіло HTTP-запиту')).toHaveCount(0);
  await page.getByLabel('Метод').selectOption('POST');
  await expect(page.getByLabel('Тіло HTTP-запиту')).toHaveValue('draft');
  await page.getByLabel('Метод').selectOption('GET');
  const created = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/proxy/workflows') &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Зберегти процес' }).click();
  const saved = await created;
  expect(saved.status()).toBe(201);
  expect(saved.request().postData()).not.toContain('"body"');
  await expect(page).toHaveURL(/\/workflows\/[a-f0-9-]+$/);

  const raw = '{"order":9007199254740993}';
  await page.getByLabel('Вхідні дані (JSON)').fill(raw);
  const response = page.waitForResponse((result) =>
    result.url().endsWith('/run'),
  );
  await page.getByRole('button', { name: 'Запустити' }).click();
  const rejected = await response;
  expect(rejected.request().postData()).toBe(raw);
  expect(rejected.status()).toBe(400);
  await expect(page.getByRole('main').getByRole('alert')).toContainText(
    'order',
  );
  const workflowId = new URL(page.url()).pathname.split('/').pop();
  const executions = await page.request.get(
    '/api/proxy/executions?workflowId=' + workflowId,
  );
  expect(executions.ok()).toBe(true);
  expect(await executions.json()).toMatchObject({ items: [] });
});
