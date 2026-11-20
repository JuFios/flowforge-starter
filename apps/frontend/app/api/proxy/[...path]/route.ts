import { NextRequest, NextResponse } from 'next/server';
import {
  allowedPath,
  FORWARDED_REQUEST_HEADERS,
  FORWARDED_RESPONSE_HEADERS,
  MAX_PROXY_BODY_BYTES,
} from '@/lib/proxy-routes';
import {
  clientIpOf,
  forbiddenOrigin,
  readLimitedBody,
  sameOrigin,
} from '@/lib/request-guards';
import {
  sessionCookieName,
  sessionCookieOptions,
  validSessionToken,
} from '@/lib/session';
import { callApi, UpstreamUnavailableError } from '@/lib/upstream';

export const dynamic = 'force-dynamic';

const NO_STORE = 'private, no-store';

function error(status: number, body: Record<string, unknown>): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { 'cache-control': NO_STORE },
  });
}

/**
 * Проксі браузер → API (README, «Межа довіри браузера»). Передає статус, безпечне тіло помилки
 * й потрібні заголовки (`Retry-After`, `X-RateLimit-*`, `x-request-id`) без змін, а IP клієнта —
 * через `X-Forwarded-For`, якому API довіряє лише від адреси фронтенду (`TRUST_PROXY`).
 * Токен сесії йде в API як `Authorization: Bearer`, у браузер він ніколи не повертається.
 */
async function proxy(
  req: NextRequest,
  { params }: { params: { path: string[] } },
): Promise<Response> {
  const method = req.method.toUpperCase();
  const path = allowedPath(method, params.path);
  if (!path)
    return error(404, { error: 'not_found', message: 'маршрут не знайдено' });
  if (method !== 'GET' && !sameOrigin(req)) return forbiddenOrigin();
  const token = validSessionToken(req.cookies.get(sessionCookieName())?.value);
  if (!token)
    return error(401, {
      error: 'session_expired',
      message: 'сесія завершилася, увійдіть знову',
    });

  const headers = new Headers({ authorization: `Bearer ${token}` });
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const ip = clientIpOf(req);
  if (ip) headers.set('x-forwarded-for', ip);

  let body: Uint8Array | undefined;
  if (method !== 'GET' && method !== 'DELETE') {
    const read = await readLimitedBody(req, MAX_PROXY_BODY_BYTES);
    if (read === undefined)
      return error(413, {
        error: 'payload_too_large',
        message: `тіло запиту більше за ${MAX_PROXY_BODY_BYTES} байт`,
      });
    body = read ?? undefined;
  }

  let upstream: Response;
  try {
    upstream = await callApi({
      method,
      path: `/${path}${req.nextUrl.search}`,
      headers,
      body,
      signal: req.signal,
    });
  } catch (err) {
    if (err instanceof UpstreamUnavailableError)
      return error(err.reason === 'timeout' ? 504 : 502, {
        error: 'upstream_unavailable',
        message:
          err.reason === 'interrupted'
            ? 'зв’язок з API перервався; результат запиту невідомий'
            : 'API тимчасово недоступний',
      });
    throw err;
  }

  const out = new Headers({ 'cache-control': NO_STORE });
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) out.set(name, value);
  }
  if (upstream.status === 401) {
    // Сесію відкликано або вона сплила: cookie прибираємо, браузер переходить до входу.
    await upstream.body?.cancel();
    const res = error(401, {
      error: 'session_expired',
      message: 'сесія завершилася, увійдіть знову',
    });
    res.cookies.set(sessionCookieName(), '', {
      ...sessionCookieOptions(),
      maxAge: 0,
    });
    return res;
  }
  // Потік без буферизації: пам'ять фронтенду не залежить від розміру відповіді.
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export const GET = proxy;
export const POST = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
