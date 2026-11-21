import { expect, test } from '@playwright/test';
import { apiRequest } from '../lib/client-api';

/**
 * Дедлайн браузерного клієнта без браузера: підмінений `fetch`, тіло, що ніколи не закінчується, і
 * пізня відповідь. Дедлайн охоплює заголовки й читання тіла, відрізняється від скасування, а
 * пізній результат нічого не змінює.
 */
const realFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Відповідь із заголовками, тіло якої не закривається (зависле з'єднання після заголовків). */
function stalledBody(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"id":'));
    },
  });
  return new Response(stream, {
    status: 201,
    headers: { 'content-type': 'application/json' },
  });
}

test('ends a request whose body stalls after the headers at the deadline', async () => {
  globalThis.fetch = () => Promise.resolve(stalledBody());
  const started = Date.now();
  const result = await apiRequest('POST', 'workflows/x/run', {
    rawJson: '{}',
    idempotencyKey: 'k',
    timeoutMs: 100,
  });
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(result).toEqual({
    kind: 'network',
    message: 'сервер не відповів вчасно',
    uncertain: true,
    timedOut: true,
  });
});

test('ends a request whose headers never arrive, even if fetch ignores the signal', async () => {
  globalThis.fetch = () => new Promise<Response>(() => undefined);
  const result = await apiRequest('GET', 'workflows', { timeoutMs: 100 });
  expect(result).toMatchObject({
    kind: 'network',
    uncertain: false,
    timedOut: true,
  });
});

test('ignores a response that arrives after the deadline', async () => {
  let respond!: (r: Response) => void;
  globalThis.fetch = () =>
    new Promise<Response>((resolve) => {
      respond = resolve;
    });
  const result = await apiRequest('DELETE', 'workflows/x', { timeoutMs: 50 });
  respond(new Response(null, { status: 204 }));
  expect(result).toMatchObject({ kind: 'network', timedOut: true });
});

test('reports a cancellation by the caller as aborted, not as a timeout', async () => {
  globalThis.fetch = () => new Promise<Response>(() => undefined);
  const caller = new AbortController();
  const pending = apiRequest('GET', 'executions', {
    signal: caller.signal,
    timeoutMs: 5_000,
  });
  caller.abort();
  expect(await pending).toEqual({ kind: 'aborted' });
  expect(
    await apiRequest('GET', 'executions', { signal: caller.signal }),
  ).toEqual({ kind: 'aborted' });
});

test('returns a timely response within the deadline unchanged', async () => {
  globalThis.fetch = () =>
    Promise.resolve(
      new Response('{"id":"e1"}', {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );
  expect(
    await apiRequest('POST', 'workflows/x/run', {
      rawJson: '{}',
      timeoutMs: 1_000,
    }),
  ).toEqual({ kind: 'ok', status: 201, data: { id: 'e1' } });
});
