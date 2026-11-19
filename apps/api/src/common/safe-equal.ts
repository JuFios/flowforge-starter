import { timingSafeEqual } from 'crypto';

/**
 * Порівняння секретів за сталий час: тривалість не залежить від того, скільки перших символів
 * збіглося (довжина значення секретом не є).
 */
export function safeEqual(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string') return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
