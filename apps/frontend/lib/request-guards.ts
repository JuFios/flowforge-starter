import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { frontendConfig } from './server-config';

/**
 * Захист маршрутів фронтенду, що змінюють стан: Origin має збігатися з origin самого фронтенду
 * (PUBLIC_ORIGIN або схема й Host, які обчислив власний сервер). Разом із SameSite=Lax cookie це
 * закриває CSRF: чужий сайт не може надіслати POST від імені сесії, а вхід із чужої сторінки не
 * підмінить сесію користувача на сесію атакувальника.
 */
export function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  const expected = frontendConfig().publicOrigin;
  if (expected) return origin === expected;
  const host = req.headers.get('host');
  const proto =
    req.headers.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
  return host !== null && origin === `${proto}://${host}`;
}

export function forbiddenOrigin(): NextResponse {
  return NextResponse.json(
    { error: 'forbidden_origin', message: 'запит з іншого origin відхилено' },
    { status: 403, headers: { 'cache-control': 'private, no-store' } },
  );
}

/**
 * Читає тіло запиту не більше `limit` байт: довше тіло перериває читання й дає undefined, тож
 * пам'ять сервера не залежить від того, скільки надіслав клієнт.
 */
export async function readLimitedBody(
  req: NextRequest,
  limit: number,
): Promise<Uint8Array | undefined | null> {
  if (!req.body) return null;
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > limit) return undefined;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** IP клієнта, обчислений власним сервером (server.ts) з довіреного ланцюжка. */
export function clientIpOf(req: NextRequest): string | undefined {
  return req.headers.get('x-forwarded-for') ?? undefined;
}
