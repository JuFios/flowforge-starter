import { BadRequestException } from '@nestjs/common';

export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/** Видимі символи ASCII без пробілу: ключ — непрозорий ідентифікатор клієнта (напр., UUID). */
const KEY = /^[\x21-\x7e]+$/;

/**
 * Значення заголовка `Idempotency-Key` запуску: 1..255 видимих символів ASCII. Кидає
 * BadRequestException з поясненням.
 */
export function parseIdempotencyKey(value: string): string {
  if (value.length > MAX_IDEMPOTENCY_KEY_LENGTH || !KEY.test(value))
    throw new BadRequestException(
      `Idempotency-Key має містити 1..${MAX_IDEMPOTENCY_KEY_LENGTH} видимих символів ASCII без пробілів`,
    );
  return value;
}
