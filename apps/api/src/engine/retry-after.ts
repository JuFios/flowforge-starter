/**
 * Затримка з заголовка `Retry-After` (RFC 9110, 10.2.3), мс: ціле число секунд або HTTP-date.
 * Дата в минулому — 0. Невалідне значення (від'ємне, дробове, сміття) — undefined: тоді діє
 * звичайний backoff. Межі (мінімум і максимум) накладає черга, а не цей розбір.
 */
export function parseRetryAfter(
  header: string | null,
  now: number = Date.now(),
): number | undefined {
  if (header === null) return undefined;
  const value = header.trim();
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) ? seconds * 1000 : undefined;
  }
  // Лише формат дати HTTP (IMF-fixdate тощо), а не будь-що, що вміє розібрати Date.parse.
  if (!/^[A-Za-z]{3},? /.test(value)) return undefined;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}
