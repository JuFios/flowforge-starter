import { expect, test } from '@playwright/test';
import { createUpstream, UpstreamUnavailableError } from '../lib/upstream';
import { closedPort, healthyApi, resettingApi, silentApi } from './fake-api';

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

  const started = Date.now();
  const response = await callApi(get('/second'));
  expect(response.status).toBe(200);
  await response.arrayBuffer();
  expect(Date.now() - started).toBeLessThan(TIMEOUT_MS / 2);

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
