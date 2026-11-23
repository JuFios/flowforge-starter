import { InstancePool, readyProbe, sharedInstancePool } from './instance-pool';
import { frontendConfig } from './server-config';

/**
 * Запит до API з серверної частини фронтенду. Інстанси з API_URLS перебираються, лише якщо
 * з'єднання не встановилося (адреса не відповідає, DNS): тоді запит точно не дійшов до API, і
 * повтор на іншому інстансі безпечний навіть для POST. Будь-яка інша помилка після відправлення
 * (обрив, таймаут відповіді) не повторюється: результат невідомий, і вирішує клієнт за семантикою
 * маршруту (README, «Фронтенд: повтор після невизначеної відповіді»). Порядок перебору веде
 * `InstancePool`: інстанс, що не прийняв з'єднання або не пройшов перевірку `/ready` після
 * таймауту чи обриву, не стоїть першим для наступних запитів. Тіло відповіді передається потоком
 * і стан інстансу не змінює: його швидкість залежить і від клієнта.
 */
const CONNECT_ERRORS = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

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

export interface UpstreamOptions {
  apiUrls: URL[];
  apiTimeoutMs: number;
}

export type CallApi = (request: UpstreamRequest) => Promise<Response>;

export function createUpstream(
  { apiUrls, apiTimeoutMs }: UpstreamOptions,
  pool = new InstancePool(apiUrls.length, readyProbe(apiUrls)),
): CallApi {
  return async (request) => {
    const timeout = AbortSignal.timeout(apiTimeoutMs);
    const signal = request.signal
      ? AbortSignal.any([request.signal, timeout])
      : timeout;
    for (const index of pool.order()) {
      const attempt = pool.begin();
      try {
        const response = await fetch(new URL(request.path, apiUrls[index]), {
          method: request.method,
          headers: request.headers,
          body: request.body ? new Uint8Array(request.body).buffer : undefined,
          signal,
          redirect: 'manual',
          cache: 'no-store',
        });
        pool.succeeded(index, attempt);
        return response;
      } catch (err) {
        // Браузер пішов сам: це не свідчення про стан інстансу.
        if (request.signal?.aborted && !timeout.aborted) throw err;
        if (!timeout.aborted && connectFailure(err)) {
          pool.failed(index, attempt);
          continue;
        }
        // Запит міг дійти до API: причиною може бути він сам, тож стан інстансу вирішує `/ready`.
        pool.check(index, attempt);
        throw new UpstreamUnavailableError(
          timeout.aborted ? 'timeout' : 'interrupted',
        );
      }
    }
    throw new UpstreamUnavailableError('unreachable');
  };
}

let shared: CallApi | undefined;

export function callApi(request: UpstreamRequest): Promise<Response> {
  if (!shared) {
    const config = frontendConfig();
    shared = createUpstream(config, sharedInstancePool(config.apiUrls));
  }
  return shared(request);
}
