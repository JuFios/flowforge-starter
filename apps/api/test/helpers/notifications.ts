import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { RunningApp } from './app';
import { newSecret } from './credentials';
import { api } from './queue';

/**
 * Незалежна перевірка підпису сповіщення так, як її робить отримувач за README: HMAC-SHA256 над
 * `v1\n<id>\n<timestamp>\n` і сирими байтами тіла, порівняння без витоку часу; заголовок може
 * нести кілька підписів через кому (ротація).
 */
export function verifyNotification(
  headers: IncomingHttpHeaders,
  raw: Buffer,
  secret: string,
): boolean {
  const id = headers['x-flowforge-event-id'];
  const timestamp = headers['x-flowforge-timestamp'];
  const signature = headers['x-flowforge-signature'];
  if (
    typeof id !== 'string' ||
    typeof timestamp !== 'string' ||
    typeof signature !== 'string'
  )
    return false;
  const expected = createHmac('sha256', secret)
    .update(`v1\n${id}\n${timestamp}\n`)
    .update(raw)
    .digest();
  return signature.split(',').some((part) => {
    const value = part.trim();
    if (!/^v1=[0-9a-f]{64}$/.test(value)) return false;
    return timingSafeEqual(Buffer.from(value.slice(3), 'hex'), expected);
  });
}

/**
 * Налаштовує сповіщення тенанта через API з секретом, який генерує тест (ТЗ 4: сервер секрет не
 * повертає); повертає цей секрет і ID ключа з відповіді.
 */
export async function configureNotifications(
  app: RunningApp,
  apiKey: string,
  url: string,
  enabled = true,
): Promise<{ secret: string; keyId: string }> {
  const secret = newSecret();
  const res = await api<{ keys: Array<{ id: string }> }>(
    app.baseUrl,
    apiKey,
    'PUT',
    '/tenants/me/notifications',
    { url, enabled, secret },
  );
  if (res.status !== 200)
    throw new Error(`PUT /tenants/me/notifications → ${res.status}`);
  return { secret, keyId: res.body.keys[0].id };
}
