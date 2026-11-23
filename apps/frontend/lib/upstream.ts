import { InstancePool, sharedInstancePool } from './instance-pool';
import { frontendConfig } from './server-config';

/**
 * Запит до API з серверної частини фронтенду. Інстанси з API_URLS перебираються, лише якщо
 * з'єднання не встановилося (адреса не відповідає, DNS): тоді запит точно не дійшов до API, і
 * повтор на іншому інстансі безпечний навіть для POST. Будь-яка інша помилка після відправлення
 * (обрив, таймаут відповіді) не повторюється: результат невідомий, і вирішує клієнт за семантикою
 * маршруту (README, «Фронтенд: повтор після невизначеної відповіді»). Порядок перебору веде
 * `InstancePool`: інстанс, що завис чи обірвав з'єднання, не стоїть першим для наступних запитів.
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
  pool = new InstancePool(apiUrls.length),
): CallApi {
  return async (request) => {
    const timeout = AbortSignal.timeout(apiTimeoutMs);
    const signal = request.signal
      ? AbortSignal.any([request.signal, timeout])
      : timeout;
    for (const index of pool.order()) {
      const attempt = pool.begin();
      const started = Date.now();
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
        return watchBody(response, () => {
          if (!request.signal?.aborted) pool.failed(index, attempt);
        });
      } catch (err) {
        if (timeout.aborted) {
          // Бюджет спільний для всіх спроб. Інстанс, якому дісталося менше половини (решту з'їв
          // таймаут з'єднання з попереднім), за таймаут не відповідає.
          if (Date.now() - started >= apiTimeoutMs / 2)
            pool.failed(index, attempt);
          throw new UpstreamUnavailableError('timeout');
        }
        // Браузер пішов сам: це не свідчення про стан інстансу.
        if (request.signal?.aborted) throw err;
        pool.failed(index, attempt);
        if (connectFailure(err)) continue;
        throw new UpstreamUnavailableError('interrupted');
      }
    }
    throw new UpstreamUnavailableError('unreachable');
  };
}

/**
 * Тіло читається вже після `succeeded`: обрив чи таймаут посеред тіла (заголовки прийшли, далі
 * тиша) теж позначає інстанс. Скасування з боку браузера — ні.
 */
function watchBody(response: Response, onFailure: () => void): Response {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let part: ReadableStreamReadResult<Uint8Array>;
      try {
        part = await reader.read();
      } catch (err) {
        onFailure();
        controller.error(err);
        return;
      }
      if (part.done) controller.close();
      else controller.enqueue(part.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

let shared: CallApi | undefined;

export function callApi(request: UpstreamRequest): Promise<Response> {
  if (!shared) {
    const config = frontendConfig();
    shared = createUpstream(config, sharedInstancePool(config.apiUrls));
  }
  return shared(request);
}
