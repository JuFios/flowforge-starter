import { frontendConfig } from './server-config';

/**
 * Запит до API з серверної частини фронтенду. Інстанси з API_URLS перебираються, лише якщо
 * з'єднання не встановилося (адреса не відповідає, DNS): тоді запит точно не дійшов до API, і
 * повтор на іншому інстансі безпечний навіть для POST. Будь-яка інша помилка після відправлення
 * (обрив, таймаут відповіді) не повторюється: результат невідомий, і вирішує клієнт за семантикою
 * маршруту (README, «Фронтенд: повтор після невизначеної відповіді»).
 */
const CONNECT_ERRORS = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** Звідки починати перебір: інстанс, що відповів останнім. */
let preferred = 0;

export class UpstreamUnavailableError extends Error {
  constructor(readonly reason: 'unreachable' | 'timeout' | 'interrupted') {
    super(`API is ${reason}`);
  }
}

function connectFailure(err: unknown): boolean {
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === 'string' && CONNECT_ERRORS.has(cause.code);
}

export interface UpstreamRequest {
  method: string;
  /** Шлях API з query, починається з «/». */
  path: string;
  headers: Headers;
  body?: Uint8Array;
  /** Скасування від клієнта (браузер закрив запит). */
  signal?: AbortSignal;
}

export async function callApi(request: UpstreamRequest): Promise<Response> {
  const { apiUrls, apiTimeoutMs } = frontendConfig();
  const timeout = AbortSignal.timeout(apiTimeoutMs);
  const signal = request.signal
    ? AbortSignal.any([request.signal, timeout])
    : timeout;
  const start = preferred;
  for (let attempt = 0; attempt < apiUrls.length; attempt++) {
    const index = (start + attempt) % apiUrls.length;
    try {
      const response = await fetch(new URL(request.path, apiUrls[index]), {
        method: request.method,
        headers: request.headers,
        body: request.body ? new Uint8Array(request.body).buffer : undefined,
        signal,
        redirect: 'manual',
        cache: 'no-store',
      });
      preferred = index;
      return response;
    } catch (err) {
      if (timeout.aborted) throw new UpstreamUnavailableError('timeout');
      if (request.signal?.aborted) throw err;
      if (connectFailure(err)) continue;
      throw new UpstreamUnavailableError('interrupted');
    }
  }
  throw new UpstreamUnavailableError('unreachable');
}
