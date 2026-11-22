'use client';

import type { ApiErrorBody } from './types';

/**
 * Запити браузера до API через проксі фронтенду. Результат — значення з видом відповіді, щоб
 * кожен екран обробив усі випадки явно: успіх, відмова сервера (з полями й `Retry-After`),
 * сесія, що сплила, і мережева помилка, після якої результат запиту невідомий.
 */
export type ClientResult<T> =
  | { kind: 'ok'; status: number; data: T }
  | {
      kind: 'rejected';
      status: number;
      error: string;
      message: string;
      messages: string[];
      retryAfterSeconds?: number;
      correlationId?: string;
    }
  | { kind: 'session_expired' }
  | {
      kind: 'network';
      message: string;
      uncertain: boolean;
      /** Дедлайн запиту минув (на відміну від обриву зв'язку). */
      timedOut?: true;
    }
  | { kind: 'aborted' };

/**
 * Дедлайн кожного запиту браузера: від надсилання до кінця читання тіла. Без нього завислий
 * проксі чи мережа лишали б кнопку заблокованою без повідомлення (ТЗ 4: усі зовнішні виклики мають
 * таймаути).
 */
export const REQUEST_TIMEOUT_MS = 30_000;

export type RequestOptions = (
  { body?: unknown; rawJson?: never } | { body?: never; rawJson: string }
) & {
  idempotencyKey?: string;
  /** Скасування викликачем (вихід зі сторінки, новіший запит): результат `aborted`. */
  signal?: AbortSignal;
  /** Дедлайн цього запиту, мс (за замовчуванням REQUEST_TIMEOUT_MS). */
  timeoutMs?: number;
};

function messagesOf(body: ApiErrorBody | undefined): string[] {
  const message = body?.message;
  if (Array.isArray(message))
    return message.filter((m) => typeof m === 'string');
  return typeof message === 'string' && message ? [message] : [];
}

function retryAfterSeconds(value: string | null): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+$/.test(text))
    return Math.min(Number(text), Math.floor(Number.MAX_SAFE_INTEGER / 1000));
  if (!/^[A-Z][a-z]{2}[ ,]/.test(text)) return undefined;
  const date = Date.parse(text);
  return Number.isFinite(date)
    ? Math.max(0, Math.ceil((date - Date.now()) / 1000))
    : undefined;
}

/**
 * Запит із дедлайном, що охоплює і заголовки, і читання тіла. Дедлайн і скасування викликачем
 * завершують запит одразу, навіть якщо `fetch` чи читання тіла не реагують на сигнал; пізня
 * відповідь уже нічого не змінює. Минулий дедлайн — `network` з `timedOut`, і для змін стану
 * (POST/PATCH/DELETE) результат невідомий: запит міг дійти до API.
 */
export async function apiRequest<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  options: RequestOptions = {},
): Promise<ClientResult<T>> {
  if (options.signal?.aborted) return { kind: 'aborted' };
  const controller = new AbortController();
  let timedOut = false;
  let throttled: ClientResult<T> | undefined;
  const onCallerAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onCallerAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const interrupted = new Promise<ClientResult<T>>((resolve) =>
    controller.signal.addEventListener(
      'abort',
      () =>
        resolve(
          timedOut
            ? (throttled ?? {
                kind: 'network',
                message: 'сервер не відповів вчасно',
                uncertain: method !== 'GET',
                timedOut: true,
              })
            : { kind: 'aborted' },
        ),
      { once: true },
    ),
  );
  try {
    return await Promise.race([
      interrupted,
      send<T>(method, path, options, controller.signal, (response) => {
        throttled = response;
      }),
    ]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onCallerAbort);
  }
}

async function send<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  options: RequestOptions,
  signal: AbortSignal,
  onThrottled: (response: ClientResult<T>) => void,
): Promise<ClientResult<T>> {
  const headers: Record<string, string> = {};
  const bodyText =
    options.rawJson ??
    (options.body === undefined ? undefined : JSON.stringify(options.body));
  if (bodyText !== undefined) headers['content-type'] = 'application/json';
  if (options.idempotencyKey)
    headers['idempotency-key'] = options.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(`/api/proxy/${path}`, {
      method,
      headers,
      body: bodyText,
      signal,
      cache: 'no-store',
      credentials: 'same-origin',
    });
  } catch (err) {
    if (signal.aborted) return { kind: 'aborted' };
    void err;
    return {
      kind: 'network',
      message: 'немає зв’язку з сервером',
      // GET безпечно повторити; для змін стану результат невідомий.
      uncertain: method !== 'GET',
    };
  }
  if (res.status === 401) return { kind: 'session_expired' };
  if (res.status === 204)
    return { kind: 'ok', status: 204, data: undefined as T };
  const retryAfter = retryAfterSeconds(res.headers.get('retry-after'));
  const throttled: ClientResult<T> | undefined =
    res.status === 429 && retryAfter !== undefined
      ? {
          kind: 'rejected',
          status: 429,
          error: 'rate_limited',
          message: 'Забагато запитів',
          messages: [],
          retryAfterSeconds: retryAfter,
          correlationId: res.headers.get('x-request-id') ?? undefined,
        }
      : undefined;
  if (throttled) onThrottled(throttled);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    if (signal.aborted) return { kind: 'aborted' };
    return (
      throttled ?? {
        kind: 'network',
        message: 'відповідь сервера обірвалася',
        uncertain: method !== 'GET',
      }
    );
  }
  if (res.ok) return { kind: 'ok', status: res.status, data: body as T };
  const error = body as ApiErrorBody;
  // 502/504 від проксі: зв'язок із API перервався, тож для змін стану результат невідомий.
  if (
    (res.status === 502 || res.status === 504) &&
    error?.error === 'upstream_unavailable'
  )
    return {
      kind: 'network',
      message: messagesOf(error)[0] ?? 'API тимчасово недоступний',
      uncertain: method !== 'GET',
    };
  const messages = messagesOf(error);
  return {
    kind: 'rejected',
    status: res.status,
    error: typeof error?.error === 'string' ? error.error : String(res.status),
    message: messages.join('; ') || `помилка ${res.status}`,
    messages,
    retryAfterSeconds: retryAfter,
    correlationId: res.headers.get('x-request-id') ?? error?.correlationId,
  };
}

/** Перехід на вхід після сесії, що сплила; повернення — на поточну сторінку. */
export function goToLogin(): void {
  const next = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`/login?expired=1&next=${encodeURIComponent(next)}`);
}

/** Текст відмови для людини, зокрема лімітів із `Retry-After`. */
export function describeRejection(
  result: Extract<ClientResult<unknown>, { kind: 'rejected' }>,
): string {
  if (result.error === 'rate_limited')
    return `Забагато запитів. Спробуйте через ${result.retryAfterSeconds ?? 'кілька'} с.`;
  if (result.error === 'queue_full')
    return 'Черга тенанта заповнена: дочекайтеся завершення запущених виконань.';
  if (result.error === 'workflow_limit_reached') return `${result.message}.`;
  return result.message;
}
