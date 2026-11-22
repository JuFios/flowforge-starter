import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { newTenant, session } from './fixtures';

test('a tenant edits a masked header, runs a workflow and follows its durable result', async ({
  browser,
  page,
  request,
}) => {
  const account = await newTenant(request);
  const other = await newTenant(request);
  const origin = process.env.FRONTEND_ORIGIN ?? 'http://localhost:3001';
  const marker = randomUUID();
  const digest = createHash('sha256').update(marker).digest('hex');
  await page.goto('/login');
  await page.getByLabel('API-ключ', { exact: true }).fill(account.apiKey);
  await page.getByRole('button', { name: 'Увійти' }).click();
  await expect(page).toHaveURL(/\/workflows$/);
  expect(
    (await page.context().cookies()).some((c) => c.value === account.apiKey),
  ).toBe(false);
  await page.getByRole('link', { name: 'Створити процес' }).click();
  await page.getByLabel('Назва процесу').fill('Перевірка отримувача');
  await page.getByLabel('Тип кроку').selectOption('http');
  await page.getByLabel('URL запиту').fill('http://sink:8080/header-digest');
  await page.getByRole('button', { name: 'Додати заголовок' }).click();
  await page.getByLabel('Назва заголовка').fill('X-Test-Marker');
  await page.getByLabel('Значення', { exact: true }).fill(marker);
  await page.getByRole('button', { name: 'Додати крок' }).click();
  await page.getByLabel('Тип кроку').nth(1).selectOption('delay');
  await page.getByLabel('Затримка, мс').fill('12000');
  await page.getByRole('button', { name: 'Зберегти процес' }).click();
  await page.getByRole('button', { name: 'Редагувати' }).click();
  await expect(page.getByText('Збережено', { exact: true })).toBeVisible();
  expect((await page.content()).includes(marker)).toBe(false);
  await page.getByLabel('Назва процесу').fill('Перевірений отримувач');
  await page.getByRole('button', { name: 'Зберегти процес' }).click();
  await page.getByRole('button', { name: 'Запустити' }).click();
  await expect(page).toHaveURL(/\/executions\/[0-9a-f-]+$/);
  const detail = page.url();
  await expect(page.getByText('Наживо', { exact: true })).toBeVisible();
  // Тестовий проєкт явно обрано через COMPOSE_PROJECT_NAME. Вихідний
  // інстанс зупиняється до завершення delay, інші сервіси працюють далі.
  const project = process.env.COMPOSE_PROJECT_NAME;
  const compose = (action: 'stop' | 'start') =>
    execFileSync(
      'docker',
      [
        'compose',
        '-p',
        project!,
        '-f',
        'docker-compose.yml',
        '-f',
        'docker-compose.chaos.yml',
        action,
        'api',
      ],
      { cwd: '../..', timeout: 30_000, stdio: 'pipe' },
    );
  try {
    if (project) compose('stop');
    await expect(page.getByText('Успішно', { exact: true })).toBeVisible({
      timeout: 35_000,
    });
    await expect(page.getByText('Наживо', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Результат кроку' }).first().click();
    await expect(page.locator('pre')).toContainText(digest);
    await page.setViewportSize({ width: 360, height: 780 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.locator('nav a[href="/executions"]').click();
    await expect(
      page.locator('a[href="' + new URL(detail).pathname + '"]'),
    ).toBeVisible();
    const isolated = await browser.newContext({ baseURL: origin });
    try {
      await session(isolated, other.apiKey);
      const id = new URL(detail).pathname.split('/').pop();
      const result = await isolated.request.get(
        origin + '/api/proxy/executions/' + id + '/summary',
      );
      expect(result.status()).toBe(404);
    } finally {
      await isolated.close();
    }
    await page.getByRole('button', { name: 'Вийти' }).click();
    await expect(page).toHaveURL(/\/login$/);
  } finally {
    if (project) {
      compose('start');
      const api = process.env.API_ORIGIN ?? 'http://localhost:3000';
      await expect
        .poll(
          async () => {
            try {
              return (
                await request.get(api + '/ready', { timeout: 1_000 })
              ).ok();
            } catch {
              return false;
            }
          },
          { timeout: 20_000 },
        )
        .toBe(true);
    }
  }
});
