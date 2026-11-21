import { NextRequest, NextResponse } from 'next/server';
import {
  clientIpOf,
  forbiddenOrigin,
  readLimitedBody,
  sameOrigin,
} from '@/lib/request-guards';
import {
  LEGACY_KEY_COOKIE,
  sessionCookieName,
  sessionCookieOptions,
  validSessionToken,
} from '@/lib/session';
import { callApi, UpstreamUnavailableError } from '@/lib/upstream';

export const dynamic = 'force-dynamic';

const NO_STORE = 'private, no-store';
/** Ключі тенантів — до 256 символів (MAX_API_KEY_LENGTH в API); довше значення не може бути ключем. */
const MAX_KEY_LENGTH = 256;

function json(
  status: number,
  body: Record<string, unknown>,
  headers?: Headers,
) {
  const res = NextResponse.json(body, { status, headers });
  res.headers.set('cache-control', NO_STORE);
  return res;
}

function apiHeaders(req: NextRequest, extra: Record<string, string>): Headers {
  const headers = new Headers(extra);
  const ip = clientIpOf(req);
  if (ip) headers.set('x-forwarded-for', ip);
  return headers;
}

/** Відкликає поточну сесію в API; результат визначає, чи можна прибрати cookie. */
async function revoke(
  req: NextRequest,
  token: string,
): Promise<Response | null> {
  try {
    const res = await callApi({
      method: 'DELETE',
      path: '/sessions/current',
      headers: apiHeaders(req, { authorization: `Bearer ${token}` }),
    });
    await res.body?.cancel();
    if (res.ok || res.status === 401) return null;
    if (res.status === 429) {
      const headers = sessionResponseHeaders(res);
      return json(
        429,
        {
          error: 'rate_limited',
          message: 'Забагато спроб завершити сесію. Спробуйте пізніше.',
        },
        headers,
      );
    }
    return revokeUnavailable();
  } catch {
    return revokeUnavailable();
  }
}

function sessionResponseHeaders(upstream: Response): Headers {
  const headers = new Headers();
  for (const name of [
    'retry-after',
    'x-ratelimit-limit',
    'x-ratelimit-remaining',
    'x-ratelimit-reset',
    'x-request-id',
  ]) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

/**
 * Вхід: ключ, який ввів користувач, обмінюється в API на сесію (`POST /sessions`) і далі ніде не
 * зберігається. Попередня сесія цього браузера (зокрема іншого тенанта) відкликається.
 */
export async function POST(req: NextRequest): Promise<Response> {
  if (!sameOrigin(req)) return forbiddenOrigin();
  const raw = await readLimitedBody(req, 4096);
  if (raw === undefined)
    return json(413, {
      error: 'payload_too_large',
      message: 'Тіло запиту перевищує 4096 байт',
    });
  let apiKey: unknown;
  try {
    apiKey = raw
      ? (JSON.parse(new TextDecoder().decode(raw)) as { apiKey?: unknown })
          .apiKey
      : undefined;
  } catch {
    apiKey = undefined;
  }
  if (
    typeof apiKey !== 'string' ||
    apiKey.trim() === '' ||
    apiKey.length > MAX_KEY_LENGTH
  )
    return json(400, {
      error: 'invalid_request',
      message: 'введіть API-ключ тенанта',
    });

  const previous = validSessionToken(
    req.cookies.get(sessionCookieName())?.value,
  );
  if (previous) {
    const rejection = await revoke(req, previous);
    if (rejection) return rejection;
  }

  let upstream: Response;
  try {
    upstream = await callApi({
      method: 'POST',
      path: '/sessions',
      headers: apiHeaders(req, { 'x-api-key': apiKey.trim() }),
    });
  } catch (err) {
    if (err instanceof UpstreamUnavailableError)
      return json(err.reason === 'timeout' ? 504 : 502, {
        error: 'upstream_unavailable',
        message: 'API тимчасово недоступний, спробуйте ще раз',
      });
    throw err;
  }
  const passthrough = sessionResponseHeaders(upstream);
  if (upstream.status !== 201) {
    const body = (await upstream.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const res = json(
      upstream.status,
      upstream.status === 401
        ? { error: 'invalid_key', message: 'ключ не підходить' }
        : {
            error: typeof body.error === 'string' ? body.error : 'login_failed',
            message:
              typeof body.message === 'string'
                ? body.message
                : 'не вдалося увійти',
          },
      passthrough,
    );
    res.cookies.set(sessionCookieName(), '', {
      ...sessionCookieOptions(),
      maxAge: 0,
    });
    return res;
  }
  const session = (await upstream.json()) as {
    token: string;
    expiresAt: string;
  };
  const res = json(201, { expiresAt: session.expiresAt }, passthrough);
  res.cookies.set(sessionCookieName(), session.token, sessionCookieOptions());
  res.cookies.set(LEGACY_KEY_COOKIE, '', { path: '/', maxAge: 0 });
  return res;
}

function revokeUnavailable() {
  return json(503, {
    error: 'session_unavailable',
    message: 'Не вдалося підтвердити відкликання сесії. Повторіть запит.',
  });
}

/** Cookie лишається доступним для повторного відкликання після відновлення API. */
export async function DELETE(req: NextRequest): Promise<Response> {
  if (!sameOrigin(req)) return forbiddenOrigin();
  const token = validSessionToken(req.cookies.get(sessionCookieName())?.value);
  const rejection = token ? await revoke(req, token) : null;
  if (rejection) return rejection;
  const res = json(200, { revoked: true });
  res.cookies.set(sessionCookieName(), '', {
    ...sessionCookieOptions(),
    maxAge: 0,
  });
  res.cookies.set(LEGACY_KEY_COOKIE, '', { path: '/', maxAge: 0 });
  return res;
}
