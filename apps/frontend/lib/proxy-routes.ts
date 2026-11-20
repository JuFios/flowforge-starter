/**
 * Маршрути API, доступні браузеру через проксі фронтенду: лише те, чим користується інтерфейс.
 * Усе інше (ключі webhook, сповіщення, адмін-API) недоступне з браузера навіть із дійсною
 * сесією — для них є прямий API з ключем (README, «Межа довіри браузера»).
 */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const ROUTES: Array<[string, RegExp]> = [
  ['GET', /^workflows$/],
  ['POST', /^workflows$/],
  ['GET', new RegExp(`^workflows/${UUID}$`)],
  ['PATCH', new RegExp(`^workflows/${UUID}$`)],
  ['DELETE', new RegExp(`^workflows/${UUID}$`)],
  ['POST', new RegExp(`^workflows/${UUID}/run$`)],
  ['GET', /^executions$/],
  ['GET', new RegExp(`^executions/${UUID}$`)],
  ['GET', new RegExp(`^executions/${UUID}/summary$`)],
  ['GET', new RegExp(`^executions/${UUID}/output$`)],
  ['GET', new RegExp(`^executions/${UUID}/steps/(0|[1-9][0-9]?)$`)],
  ['POST', new RegExp(`^executions/${UUID}/retry$`)],
  ['POST', new RegExp(`^executions/${UUID}/realtime-tickets$`)],
];

/** Сегменти шляху з Next (уже декодовані): кожен — лише безпечні символи, без `..` і `/`. */
export function allowedPath(
  method: string,
  segments: string[],
): string | undefined {
  if (segments.length === 0 || segments.length > 4) return undefined;
  if (!segments.every((s) => /^[A-Za-z0-9-]{1,64}$/.test(s))) return undefined;
  const path = segments.join('/');
  return ROUTES.some(([m, pattern]) => m === method && pattern.test(path))
    ? path
    : undefined;
}

/** Заголовки запиту, які проксі передає в API (решту, зокрема cookie, — ні). */
export const FORWARDED_REQUEST_HEADERS = ['content-type', 'idempotency-key'];

/** Заголовки відповіді API, потрібні браузеру: ліміти, повтор, кореляція, тип. */
export const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'retry-after',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-request-id',
];

/** Найбільше тіло запиту з браузера: визначення до 64 КіБ, вхід запуску до 64 КіБ. */
export const MAX_PROXY_BODY_BYTES = 256 * 1024;
