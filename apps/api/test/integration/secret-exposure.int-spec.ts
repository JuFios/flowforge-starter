import { DataSource } from 'typeorm';
import { SchedulerService } from '../../src/scheduler/scheduler.service';
import { RunningApp, startApp } from '../helpers/app';
import { openTestDataSource, truncateAll } from '../helpers/db';
import { Receiver } from '../helpers/queue';
import { TEST_ADMIN_TOKEN } from '../helpers/test-env';

interface Exchange {
  route: string;
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * ТЗ 4: «Секрети не потрапляють у логи й відповіді API». Трактування (README, «Секрети й межа
 * §4»): новий секрет сервер показує рівно один раз — власнику, у відповіді, що його створює
 * (`Cache-Control: no-store`), — і більше ніде. Інваріант класу, незалежний від маршруту: жодна
 * інша відповідь (тіло чи заголовок) і жоден рядок логу не містить значення, яким можна
 * автентифікуватися як тенант (API-ключ, хеш якого збережено) або підписати чи перевірити webhook і
 * сповіщення (секрети в БД). Сценарій проходить видачу, ротацію, читання, відкликання й помилки
 * (400, 409, 413) усіх трьох наборів облікових даних.
 */
describe('secret exposure', () => {
  let ds: DataSource;
  let app: RunningApp;
  const receiver = new Receiver();
  const exchanges: Exchange[] = [];

  beforeAll(async () => {
    ds = await openTestDataSource();
    await receiver.start();
    app = await startApp(undefined, { captureLogs: true });
    app.app.get(SchedulerService).onApplicationShutdown();
  });
  beforeEach(async () => {
    await truncateAll(ds);
    exchanges.length = 0;
    app.logs.length = 0;
  });
  afterAll(async () => {
    await app.close();
    await receiver.stop();
    await truncateAll(ds);
    await ds.destroy();
  });

  async function send(
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: unknown,
  ): Promise<Exchange> {
    const res = await fetch(app.baseUrl + path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body:
        body === undefined
          ? undefined
          : typeof body === 'string'
            ? body
            : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      // Не JSON — перевіряється як рядок.
    }
    const exchange: Exchange = {
      route: `${method} ${path}`,
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body: parsed,
    };
    exchanges.push(exchange);
    return exchange;
  }

  /** Усі рядки значення (рекурсивно), разом із ключами об'єктів. */
  function strings(value: unknown, out: string[] = []): string[] {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) for (const v of value) strings(v, out);
    else if (value && typeof value === 'object')
      for (const [k, v] of Object.entries(value)) {
        out.push(k);
        strings(v, out);
      }
    return out;
  }

  /** Секрети підпису, які зараз зберігає БД (з будь-яких рядків, без RLS). */
  async function storedSigningSecrets() {
    const tenants: Array<{
      webhookSecret: string;
      nextWebhookSecret: string | null;
    }> = await ds.query(
      'SELECT "webhookSecret", "nextWebhookSecret" FROM tenants',
    );
    const settings: Array<{ secret: string; nextSecret: string | null }> =
      await ds.query('SELECT secret, "nextSecret" FROM notification_settings');
    return [
      ...tenants.flatMap((t) => [t.webhookSecret, t.nextWebhookSecret]),
      ...settings.flatMap((s) => [s.secret, s.nextSecret]),
    ].filter((s): s is string => typeof s === 'string' && s.length > 0);
  }

  /** Зібрані за сценарій секрети, бо відкликані ключі вже зникли з БД на момент перевірки. */
  const seenSecrets = new Set<string>();
  async function remember() {
    for (const secret of await storedSigningSecrets()) seenSecrets.add(secret);
  }

  /** Відповідь, що створює новий секрет: єдине місце, де його видно (один раз). */
  const ISSUING = new Set([
    'POST /tenants',
    'POST /tenants/me/webhook-secrets',
    'POST /tenants/me/notifications/secrets',
  ]);
  const issuing = (ex: Exchange, index: number) =>
    (ISSUING.has(ex.route) && ex.status === 201) ||
    // Перше налаштування сповіщень створює ключ; повторні PUT лише оновлюють адресу.
    (ex.route === 'PUT /tenants/me/notifications' &&
      ex.status === 200 &&
      exchanges.findIndex((e) => e.route === ex.route && e.status === 200) ===
        index);

  function assertNoCredentials(apiKey: string) {
    const leaks: string[] = [];
    exchanges.forEach((ex, index) => {
      const body =
        ex.route === 'POST /tenants' && ex.status === 201
          ? { ...(ex.body as Record<string, unknown>), apiKey: undefined }
          : ex.body;
      if (strings([ex.headers, body]).some((s) => s.includes(apiKey)))
        leaks.push(`${ex.route}: API key`);
      if (issuing(ex, index)) {
        if (ex.headers['cache-control'] !== 'no-store')
          leaks.push(`${ex.route}: issued without no-store`);
        return;
      }
      for (const s of strings([ex.headers, ex.body])) {
        for (const secret of seenSecrets)
          if (s.includes(secret)) leaks.push(`${ex.route}: signing secret`);
      }
    });
    const logStrings = strings(app.logs);
    if (logStrings.some((s) => s.includes(apiKey))) leaks.push('log: API key');
    for (const secret of seenSecrets)
      if (logStrings.some((s) => s.includes(secret)))
        leaks.push('log: signing secret');
    expect([...new Set(leaks)]).toEqual([]);
  }

  /** Кожен виданий секрет справді з'явився у своїй відповіді видачі (і лише там). */
  function assertIssuedOnce() {
    const issued = exchanges.filter(issuing);
    expect(issued.map((ex) => ex.route).sort()).toEqual(
      [
        'POST /tenants',
        'POST /tenants/me/notifications/secrets',
        'POST /tenants/me/webhook-secrets',
        'PUT /tenants/me/notifications',
      ].sort(),
    );
    const shown = strings(issued.map((ex) => ex.body));
    for (const secret of seenSecrets)
      expect(shown.some((s) => s === secret)).toBe(true);
  }

  const apiKeyOf = (created: Exchange) =>
    (created.body as { apiKey: string }).apiKey;
  const rotationBody = () => undefined;
  const settingsBody = (url: string) => ({ url });
  const newTenant = (name: string) => ({ name });

  it('shows each new secret only once, in its issuing response, and never in other responses or logs', async () => {
    const admin = { 'x-admin-token': TEST_ADMIN_TOKEN };
    const created = await send('POST', '/tenants', admin, newTenant('one'));
    expect(created.status).toBe(201);
    const id = (created.body as { id: string }).id;
    const apiKey = apiKeyOf(created);
    expect(apiKey).toMatch(/^ff_/);
    const key = { 'x-api-key': apiKey };
    await remember();

    await send('GET', `/tenants/${id}/limits`, admin);
    await send('PATCH', `/tenants/${id}/limits`, admin, { rateLimit: 100 });
    await send('POST', '/tenants', admin, { ...newTenant('x'), limits: 'bad' });
    await send('POST', '/tenants', admin, {
      ...newTenant('y'),
      apiKey: 'short',
    });

    // Ключі вхідних webhook-ів: ротація, друга ротація (409), читання, відкликання.
    expect(
      (await send('POST', '/tenants/me/webhook-secrets', key, rotationBody()))
        .status,
    ).toBe(201);
    await remember();
    expect(
      (await send('POST', '/tenants/me/webhook-secrets', key, rotationBody()))
        .status,
    ).toBe(409);
    const listed = await send('GET', '/tenants/me/webhook-secrets', key);
    const current = (listed.body as Array<{ id: string; role: string }>).find(
      (k) => k.role === 'current',
    )!;
    await send('DELETE', `/tenants/me/webhook-secrets/${current.id}`, key);

    // Сповіщення: перше налаштування, оновлення, ротація, 409, читання, відкликання, помилки.
    const url = receiver.url('/notify');
    expect(
      (await send('PUT', '/tenants/me/notifications', key, settingsBody(url)))
        .status,
    ).toBe(200);
    await remember();
    await send('PUT', '/tenants/me/notifications', key, { url });
    await send('PUT', '/tenants/me/notifications', key, { url: 'http://x' });
    expect(
      (
        await send(
          'POST',
          '/tenants/me/notifications/secrets',
          key,
          rotationBody(),
        )
      ).status,
    ).toBe(201);
    await remember();
    await send(
      'POST',
      '/tenants/me/notifications/secrets',
      key,
      rotationBody(),
    );
    const settings = await send('GET', '/tenants/me/notifications', key);
    const first = (settings.body as { keys: Array<{ id: string }> }).keys[0];
    await send('DELETE', `/tenants/me/notifications/secrets/${first.id}`, key);
    await send('GET', '/tenants/me/notifications', key);

    // Завелике й некоректне тіло, а також чужий ключ.
    await send(
      'PUT',
      '/tenants/me/notifications',
      key,
      JSON.stringify({ url: 'x'.repeat(2 * 1024 * 1024) }),
    );
    await send('PUT', '/tenants/me/notifications', key, '{"url":');
    await send('GET', '/tenants/me/notifications', {
      'x-api-key': 'ff_wrong',
    });
    await send('POST', '/sessions', key);
    await send('GET', '/metrics', {});

    await remember();
    assertNoCredentials(apiKey);
    assertIssuedOnce();
  });
});
