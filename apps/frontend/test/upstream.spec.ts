import { expect, test } from '@playwright/test';
import { InstancePool } from '../lib/instance-pool';
import { createUpstream, UpstreamUnavailableError } from '../lib/upstream';
import {
  closedPort,
  healthyApi,
  resettingApi,
  silentApi,
  stallingBodyApi,
} from './fake-api';

/**
 * HTTP-проксі фронтенду до кількох інстансів API без браузера. Запит, що міг дійти до API, не
 * повторюється на іншому інстансі (результат невідомий), але інстанс, який завис чи обірвав
 * з'єднання, не має лишатися першим для наступних запитів.
 */
const TIMEOUT_MS = 1_000;

function get(path: string, signal?: AbortSignal) {
  return { method: 'GET', path, headers: new Headers(), signal };
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
  const callApi = createUpstream({
    apiUrls: [hung.url, healthy.url],
    apiTimeoutMs: TIMEOUT_MS,
  });

  expect(await reason(callApi(get('/first')))).toBe('timeout');
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
  expect(hung.paths()).toEqual(['/first']);
  expect(healthy.paths).toHaveLength(6);
});

test('does not resend a request whose connection broke, and starts the next one elsewhere', async () => {
  const broken = await resettingApi();
  const healthy = await healthyApi();
  const callApi = createUpstream({
    apiUrls: [broken.url, healthy.url],
    apiTimeoutMs: TIMEOUT_MS,
  });

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
  expect(broken.requests).toHaveLength(1);
  expect(healthy.paths).toEqual([]);

  const response = await callApi(get('/after'));
  expect(response.status).toBe(200);
  await response.arrayBuffer();
  expect(broken.requests).toHaveLength(1);
  expect(healthy.paths).toEqual(['/after']);
});

test('fails over when the first instance refuses the connection', async () => {
  const healthy = await healthyApi();
  const callApi = createUpstream({
    apiUrls: [await closedPort(), healthy.url],
    apiTimeoutMs: TIMEOUT_MS,
  });
  const response = await callApi(get('/only'));
  expect(response.status).toBe(200);
  await response.arrayBuffer();
  expect(healthy.paths).toEqual(['/only']);
});

test('still tries an instance under suspicion when no other one answers', async () => {
  const hung = await silentApi();
  const callApi = createUpstream({
    apiUrls: [hung.url, await closedPort()],
    apiTimeoutMs: TIMEOUT_MS,
  });
  expect(await reason(callApi(get('/first')))).toBe('timeout');
  expect(await reason(callApi(get('/second')))).toBe('timeout');
  expect(hung.paths()).toEqual(['/first', '/second']);
});

test('reports an unreachable API when every instance refuses the connection', async () => {
  const callApi = createUpstream({
    apiUrls: [await closedPort(), await closedPort()],
    apiTimeoutMs: TIMEOUT_MS,
  });
  expect(await reason(callApi(get('/none')))).toBe('unreachable');
});

test('does not hold an instance responsible for a request the browser cancelled', async () => {
  const slowFirst = await silentApi();
  const healthy = await healthyApi();
  const callApi = createUpstream({
    apiUrls: [slowFirst.url, healthy.url],
    apiTimeoutMs: TIMEOUT_MS,
  });
  const browser = new AbortController();
  const pending = callApi(get('/cancelled', browser.signal));
  await expect.poll(() => slowFirst.paths()).toEqual(['/cancelled']);
  browser.abort();
  await expect(pending).rejects.toThrow();

  expect(await reason(callApi(get('/again')))).toBe('timeout');
  expect(slowFirst.paths()).toEqual(['/cancelled', '/again']);
  expect(healthy.paths).toEqual([]);
});

test('sends the next requests elsewhere after an instance stalled in the middle of a body', async () => {
  const stalling = await stallingBodyApi();
  const healthy = await healthyApi();
  const callApi = createUpstream({
    apiUrls: [stalling.url, healthy.url],
    apiTimeoutMs: TIMEOUT_MS,
  });
  const first = await callApi(get('/partial'));
  expect(first.status).toBe(200);
  await expect(first.arrayBuffer()).rejects.toThrow();

  const next = await callApi(get('/next'));
  expect(next.status).toBe(200);
  await next.arrayBuffer();
  expect(stalling.paths).toEqual(['/partial']);
  expect(healthy.paths).toEqual(['/next']);
});

test('does not blame an instance for a timeout when an earlier one used up the budget', async () => {
  const urls = [
    new URL('http://10.255.0.1:3000'),
    new URL('http://10.255.0.2:3000'),
  ];
  const pool = new InstancePool(2);
  const realFetch = globalThis.fetch;
  // Перший інстанс «з'єднується» 80 % бюджету й відмовляє як undici, другий — повільний.
  globalThis.fetch = ((input: URL, init: RequestInit) =>
    new Promise((_resolve, reject) => {
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
      signal.addEventListener('abort', () => reject(signal.reason));
    })) as typeof fetch;
  try {
    const callApi = createUpstream(
      { apiUrls: urls, apiTimeoutMs: TIMEOUT_MS },
      pool,
    );
    expect(await reason(callApi(get('/slow')))).toBe('timeout');
  } finally {
    globalThis.fetch = realFetch;
  }
  // Перший позначено за відмову з'єднання, другий лишився справним і стоїть першим.
  expect(pool.order()).toEqual([1, 0]);
});
