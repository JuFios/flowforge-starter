import { expect, test } from '@playwright/test';
import { InstancePool, readyProbe } from '../lib/instance-pool';
import { createUpstream, UpstreamUnavailableError } from '../lib/upstream';
import {
  closedPort,
  healthyApi,
  largeBodyApi,
  resettingApi,
  silentApi,
  slowRouteApi,
  stallingBodyApi,
} from './fake-api';

/**
 * HTTP-проксі фронтенду до кількох інстансів API без браузера. Запит, що міг дійти до API, не
 * повторюється на іншому інстансі (результат невідомий). Інстанс, що не прийняв з'єднання або не
 * пройшов перевірку `/ready` після таймауту чи обриву, не лишається першим для наступних запитів.
 * Повільний запит чи повільний клієнт живого інстансу порядку не змінюють.
 */
const TIMEOUT_MS = 1_000;
const PROBE_MS = 200;

function get(path: string, signal?: AbortSignal) {
  return { method: 'GET', path, headers: new Headers(), signal };
}

/** Проксі й пул, чиї перевірки `/ready` тест може дочекатися. */
function upstreamTo(apiUrls: URL[]) {
  const pool = new InstancePool(apiUrls.length, readyProbe(apiUrls, PROBE_MS));
  const callApi = createUpstream({ apiUrls, apiTimeoutMs: TIMEOUT_MS }, pool);
  return { callApi, pool };
}

async function reason(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(UpstreamUnavailableError);
  return (error as UpstreamUnavailableError).reason;
}

test('sends the next requests past an instance that accepted a connection and hung', async () => {
  const hung = await silentApi();
  const healthy = await healthyApi();
  const { callApi, pool } = upstreamTo([hung.url, healthy.url]);

  expect(await reason(callApi(get('/first')))).toBe('timeout');
  await pool.settled();
  expect(hung.paths()).toEqual(['/first', '/ready']);
  expect(healthy.paths).toEqual([]);

  const response = await callApi(get('/second'));
  expect(response.status).toBe(200);
  await response.arrayBuffer();

  const parallel = await Promise.all(
    [1, 2, 3, 4, 5].map((n) => callApi(get(`/parallel-${n}`))),
  );
  for (const r of parallel) {
    expect(r.status).toBe(200);
    await r.arrayBuffer();
  }
  expect(hung.paths()).toEqual(['/first', '/ready']);
  expect(healthy.paths).toHaveLength(6);
});

test('checks a hung instance once for parallel timeouts of one incident', async () => {
  const hung = await silentApi();
  const healthy = await healthyApi();
  const { callApi, pool } = upstreamTo([hung.url, healthy.url]);
  const reasons = await Promise.all(
    [1, 2, 3].map((n) => reason(callApi(get(`/burst-${n}`)))),
  );
  expect(reasons).toEqual(['timeout', 'timeout', 'timeout']);
  await pool.settled();
  expect(hung.paths().filter((path) => path === '/ready')).toHaveLength(1);
  expect(pool.order()).toEqual([1, 0]);
});

test('does not resend a request whose connection broke, and starts the next one elsewhere', async () => {
  const broken = await resettingApi();
  const healthy = await healthyApi();
  const { callApi, pool } = upstreamTo([broken.url, healthy.url]);

  expect(
    await reason(
      callApi({
        method: 'POST',
        path: '/executions',
        headers: new Headers({ 'content-type': 'application/json' }),
        body: new TextEncoder().encode('{}'),
      }),
    ),
  ).toBe('interrupted');
  await pool.settled();
  // Запит і перевірка `/ready`: обидва обірвано, повтору запиту немає.
  expect(broken.requests).toHaveLength(2);
  expect(broken.requests[0]).toMatch(/^POST \/executions /);
  expect(broken.requests[1]).toMatch(/^GET \/ready /);
  expect(healthy.paths).toEqual([]);

  const response = await callApi(get('/after'));
  expect(response.status).toBe(200);
  await response.arrayBuffer();
  expect(broken.requests).toHaveLength(2);
  expect(healthy.paths).toEqual(['/after']);
});

test('fails over when the first instance refuses the connection', async () => {
  const healthy = await healthyApi();
  const { callApi } = upstreamTo([await closedPort(), healthy.url]);
  const response = await callApi(get('/only'));
  expect(response.status).toBe(200);
  await response.arrayBuffer();
  expect(healthy.paths).toEqual(['/only']);
});

test('still tries an instance under suspicion when no other one answers', async () => {
  const hung = await silentApi();
  const { callApi, pool } = upstreamTo([hung.url, await closedPort()]);
  expect(await reason(callApi(get('/first')))).toBe('timeout');
  await pool.settled();
  expect(await reason(callApi(get('/second')))).toBe('timeout');
  await pool.settled();
  expect(hung.paths().filter((path) => path !== '/ready')).toEqual([
    '/first',
    '/second',
  ]);
});

test('reports an unreachable API when every instance refuses the connection', async () => {
  const { callApi } = upstreamTo([await closedPort(), await closedPort()]);
  expect(await reason(callApi(get('/none')))).toBe('unreachable');
});

test('does not hold an instance responsible for a request the browser cancelled', async () => {
  const slowFirst = await silentApi();
  const healthy = await healthyApi();
  const { callApi, pool } = upstreamTo([slowFirst.url, healthy.url]);
  const browser = new AbortController();
  const pending = callApi(get('/cancelled', browser.signal));
  await expect.poll(() => slowFirst.paths()).toEqual(['/cancelled']);
  browser.abort();
  await expect(pending).rejects.toThrow();
  await pool.settled();
  expect(slowFirst.paths()).toEqual(['/cancelled']);
  expect(pool.order()).toEqual([0, 1]);
});

/**
 * Клас тригерів, які контролює запит або клієнт, а не стан інстансу: повільний маршрут живого API,
 * тіло, що зупинилося після заголовків, і клієнт, який читає тіло пізніше за таймаут. Жоден не
 * змінює порядок перебору, тож тенант не може відвести чужі запити від справного інстансу.
 */
for (const variant of ['slow route', 'stalled body', 'slow reader'] as const)
  test(`keeps a live instance first after a ${variant}`, async () => {
    const live =
      variant === 'slow route'
        ? await slowRouteApi()
        : variant === 'stalled body'
          ? await stallingBodyApi()
          : await largeBodyApi();
    const other = await healthyApi();
    const { callApi, pool } = upstreamTo([live.url, other.url]);

    if (variant === 'slow route') {
      expect(await reason(callApi(get('/detail')))).toBe('timeout');
    } else {
      const response = await callApi(get('/detail'));
      expect(response.status).toBe(200);
      // Клієнт не читає тіло, поки не спливе бюджет запиту. В обох варіантах тіло ще не
      // отримано повністю, тож читання обривається посеред тіла.
      await new Promise((r) => setTimeout(r, TIMEOUT_MS * 1.2));
      await expect(response.arrayBuffer()).rejects.toThrow();
    }
    await pool.settled();
    expect(pool.order()).toEqual([0, 1]);
    expect(other.paths).toEqual([]);
    // Перевірка `/ready` — лише для таймауту запиту; тіло стан інстансу не змінює.
    expect(live.paths.filter((path) => path === '/ready')).toHaveLength(
      variant === 'slow route' ? 1 : 0,
    );
  });

test('does not blame an instance for a timeout when an earlier one used up the budget', async () => {
  const urls = [
    new URL('http://10.255.0.1:3000'),
    new URL('http://10.255.0.2:3000'),
  ];
  const pool = new InstancePool(2, readyProbe(urls, PROBE_MS));
  const realFetch = globalThis.fetch;
  // Перший інстанс «з'єднується» 80 % бюджету й відмовляє як undici. Другий живий (`/ready`
  // відповідає), але запиту не встигає відповісти до кінця бюджету.
  globalThis.fetch = ((input: URL, init: RequestInit) =>
    new Promise((resolve, reject) => {
      const signal = init.signal!;
      if (input.hostname === '10.255.0.1')
        setTimeout(
          () =>
            reject(
              Object.assign(new TypeError('fetch failed'), {
                cause: { code: 'UND_ERR_CONNECT_TIMEOUT' },
              }),
            ),
          TIMEOUT_MS * 0.8,
        );
      else if (input.pathname === '/ready')
        resolve(new Response('{"status":"ok"}', { status: 200 }));
      signal.addEventListener('abort', () => reject(signal.reason));
    })) as typeof fetch;
  try {
    const callApi = createUpstream(
      { apiUrls: urls, apiTimeoutMs: TIMEOUT_MS },
      pool,
    );
    expect(await reason(callApi(get('/slow')))).toBe('timeout');
    await pool.settled();
  } finally {
    globalThis.fetch = realFetch;
  }
  // Перший позначено за відмову з'єднання, другий пройшов `/ready` і стоїть першим.
  expect(pool.order()).toEqual([1, 0]);
});
