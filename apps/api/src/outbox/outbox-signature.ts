import { createHmac } from 'node:crypto';

/** Заголовки вихідного сповіщення (docs/operations.md 3.3.9, «Контракт події»). */
export const EVENT_ID_HEADER = 'x-flowforge-event-id';
export const TIMESTAMP_HEADER = 'x-flowforge-timestamp';
export const ATTEMPT_HEADER = 'x-flowforge-attempt';
export const SIGNATURE_HEADER = 'x-flowforge-signature';

/**
 * Підпис спроби: HMAC-SHA256 ключем тенанта над `v1\n<eventId>\n<timestamp>\n` і точними байтами
 * тіла, hex. Час — момент цієї спроби (вікно перевірки отримувача); байти тіла однакові для всіх
 * спроб події.
 */
export function signEvent(
  secret: string,
  eventId: string,
  timestamp: number,
  body: Buffer,
): string {
  return createHmac('sha256', secret)
    .update(`v1\n${eventId}\n${timestamp}\n`)
    .update(body)
    .digest('hex');
}

/** Значення заголовка підпису: по одному `v1=<hex>` на кожен активний ключ, через кому. */
export function signatureHeader(
  secrets: readonly string[],
  eventId: string,
  timestamp: number,
  body: Buffer,
): string {
  return secrets
    .map((secret) => `v1=${signEvent(secret, eventId, timestamp, body)}`)
    .join(', ');
}
