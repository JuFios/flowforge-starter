/** Відповідь, на яку ставляться заголовки лімітів (Express або сумісна). */
export interface HeaderTarget {
  setHeader(name: string, value: string | number): unknown;
}

/** Стан вікна ліміту для заголовків відповіді. */
export interface RateLimitState {
  limit: number;
  hits: number;
  /** Мілісекунди до кінця вікна (годинник БД). */
  resetMs: number;
}

/** Секунди до кінця вікна, не менше 1 (заголовки мають цілу кількість секунд). */
export function secondsUntilReset(resetMs: number): number {
  return Math.max(1, Math.ceil(resetMs / 1000));
}

/**
 * `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (секунди до кінця вікна) — на
 * кожну відповідь, що пройшла через ліміт; на перевищенні — ще й `Retry-After`.
 */
export function setRateLimitHeaders(
  res: HeaderTarget,
  { limit, hits, resetMs }: RateLimitState,
): void {
  const reset = secondsUntilReset(resetMs);
  res.setHeader('X-RateLimit-Limit', limit);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, limit - hits));
  res.setHeader('X-RateLimit-Reset', reset);
  if (hits > limit) res.setHeader('Retry-After', reset);
}
