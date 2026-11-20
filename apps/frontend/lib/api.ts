import 'server-only';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { sessionCookieName, validSessionToken } from './session';
import type { ApiErrorBody } from './types';
import { callApi, UpstreamUnavailableError } from './upstream';

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string; message: string };

/** Повідомлення API для людини: рядок або перелік (помилки валідації). */
export function messageOf(
  body: ApiErrorBody | undefined,
  fallback: string,
): string {
  const message = body?.message;
  if (Array.isArray(message)) return message.join('; ');
  return typeof message === 'string' && message ? message : fallback;
}

/**
 * Читання API для серверних компонентів у сесії поточного запиту. Відповіді не кешуються (дані
 * тенанта), сесія, що сплила, веде на вхід. Помилка повертається як значення: сторінка показує
 * стан помилки, а не падає.
 */
export async function serverApi<T>(
  path: string,
  returnTo: string,
): Promise<ApiResult<T>> {
  const token = validSessionToken(cookies().get(sessionCookieName())?.value);
  if (!token) redirect(`/login?next=${encodeURIComponent(returnTo)}`);
  const forwarded = new Headers({ authorization: `Bearer ${token}` });
  const ip = headers().get('x-forwarded-for');
  if (ip) forwarded.set('x-forwarded-for', ip);
  let res: Response;
  try {
    res = await callApi({ method: 'GET', path, headers: forwarded });
  } catch (err) {
    if (err instanceof UpstreamUnavailableError)
      return {
        ok: false,
        status: 503,
        error: 'upstream_unavailable',
        message: 'API тимчасово недоступний',
      };
    throw err;
  }
  if (res.status === 401) {
    await res.body?.cancel();
    redirect(`/login?expired=1&next=${encodeURIComponent(returnTo)}`);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => undefined)) as
      ApiErrorBody | undefined;
    return {
      ok: false,
      status: res.status,
      error: body?.error ?? 'error',
      message: messageOf(body, `помилка API (${res.status})`),
    };
  }
  return { ok: true, data: (await res.json()) as T };
}
