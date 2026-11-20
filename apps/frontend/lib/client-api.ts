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
  | { kind: 'network'; message: string; uncertain: boolean }
  | { kind: 'aborted' };

export interface RequestOptions {
  body?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

function messagesOf(body: ApiErrorBody | undefined): string[] {
  const message = body?.message;
  if (Array.isArray(message))
    return message.filter((m) => typeof m === 'string');
  return typeof message === 'string' && message ? [message] : [];
}

export async function apiRequest<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  options: RequestOptions = {},
): Promise<ClientResult<T>> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.idempotencyKey)
    headers['idempotency-key'] = options.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(`/api/proxy/${path}`, {
      method,
      headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
      cache: 'no-store',
      credentials: 'same-origin',
    });
  } catch (err) {
    if (options.signal?.aborted) return { kind: 'aborted' };
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
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    if (options.signal?.aborted) return { kind: 'aborted' };
    return {
      kind: 'network',
      message: 'відповідь сервера обірвалася',
      uncertain: method !== 'GET',
    };
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
  const retryAfter = Number(res.headers.get('retry-after'));
  const messages = messagesOf(error);
  return {
    kind: 'rejected',
    status: res.status,
    error: typeof error?.error === 'string' ? error.error : String(res.status),
    message: messages.join('; ') || `помилка ${res.status}`,
    messages,
    retryAfterSeconds:
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
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
