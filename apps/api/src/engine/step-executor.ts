import { Injectable, Logger } from '@nestjs/common';
import { exceedsJsonDepth, MAX_STEP_RESULT_DEPTH } from '../common/json-depth';
import { StepDefinition } from '../entities';
import { isolatedTransform } from './isolated-transform';
import { outboundHttp } from './outbound-http';
import { StepError } from './step-error';
import {
  RESERVED_HEADERS,
  MAX_LOG_MESSAGE_LENGTH,
  MAX_URL_LENGTH,
} from '../workflows/definition';
import { parseRetryAfter } from './retry-after';
import { renderTemplate, StepContext } from './template';

/**
 * Статуси, після яких запит варто повторити: таймаут запиту (408), «зарано» (425), обмеження
 * частоти (429) і помилки сервера (5xx). Решта 4xx — помилка в самому запиті, повтор її не змінить.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** Статуси, для яких отримувач може вказати, коли повторювати (`Retry-After`). */
const RETRY_AFTER_STATUSES = new Set([429, 503]);

export { StepError } from './step-error';

export interface StepRunOptions {
  /** Скасування кроку (втрата lease, завершення воркера). */
  signal?: AbortSignal;
  /** Стабільний ключ ідемпотентності кроку (для `http` — заголовок `Idempotency-Key`). */
  idempotencyKey?: string;
}

@Injectable()
export class StepExecutor {
  private readonly logger = new Logger(StepExecutor.name);

  async execute(
    step: StepDefinition,
    ctx: StepContext,
    { signal, idempotencyKey }: StepRunOptions = {},
  ): Promise<unknown> {
    switch (step.type) {
      case 'log':
        this.logger.log(
          renderTemplate(
            step.message,
            ctx,
            MAX_LOG_MESSAGE_LENGTH * 4,
            'log message is too large',
            MAX_LOG_MESSAGE_LENGTH,
          ),
        );
        return { logged: true };
      case 'delay':
        // Пауза — довговічний таймер у черзі (JobRunnerService), а не очікування в процесі.
        throw new StepError(
          'delay steps are scheduled by the job runner',
          false,
        );
      case 'transform':
        return isolatedTransform(step.expr, step.language, ctx, signal);
      case 'http':
        return this.http(step, ctx, signal, idempotencyKey);
    }
  }

  private async http(
    step: Extract<StepDefinition, { type: 'http' }>,
    ctx: StepContext,
    signal?: AbortSignal,
    idempotencyKey?: string,
  ): Promise<unknown> {
    const url = renderTemplate(
      step.url,
      ctx,
      MAX_URL_LENGTH * 4,
      'http url is invalid after template substitution',
    );
    // Підстановка значень із input/steps може зробити URL невалідним (пробіл, задовгий, інша
    // схема). Це помилка даних, а не мережі: повтор дасть той самий URL.
    if (!isValidHttpUrl(url))
      throw new StepError(
        'http url is invalid after template substitution',
        false,
      );
    let res: Awaited<ReturnType<typeof outboundHttp>>;
    try {
      const headers = new Headers(Object.entries(step.headers ?? {}));
      for (const name of headers.keys())
        if (RESERVED_HEADERS.has(name))
          throw new StepError('http request contains a reserved header', false);
      if (idempotencyKey) headers.set('Idempotency-Key', idempotencyKey);
      res = await outboundHttp(
        new URL(url),
        step.method ?? 'GET',
        headers,
        step.body !== undefined ? renderTemplate(step.body, ctx) : undefined,
        signal,
      );
    } catch (err) {
      // Скасування воркером (lease, завершення) — не помилка кроку, передаємо як є.
      if (signal?.aborted || err instanceof StepError) throw err;
      // Повторювані лише збої мережі й таймаут. Інша помилка fetch означає, що запит неможливо
      // надіслати взагалі (напр., тіло в GET), і повтор дав би той самий результат.
      if (isBlockedPort(err))
        throw new StepError(
          'http request is invalid: the port is not allowed',
          false,
        );
      if (!isNetworkFailure(err))
        throw new StepError('http request is invalid', false);
      throw new StepError(`http request failed: ${networkReason(err)}`, true);
    }
    if (res.status < 200 || res.status >= 300) {
      // Заголовки визначають результат навіть при обриві непотрібного тіла.
      throw new StepError(
        `http ${res.status}`,
        isRetryableStatus(res.status),
        RETRY_AFTER_STATUSES.has(res.status)
          ? parseRetryAfter(res.headers.get('retry-after'))
          : undefined,
      );
    }
    const text = res.body;
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      // Увесь текст: розмір уже обмежив readLimited (HTTP_RESPONSE_BYTES, та сама межа, що й для
      // JSON). Обрізання змінило б дані для наступних кроків при успішному статусі кроку.
      return { status: res.status, body: text };
    }
    // Результат кроку зберігається в jsonb і серіалізується (рекурсивно) у чекпоінті й шаблонах
    // наступних кроків: надглибокий JSON переповнив би стек. Повтор дав би той самий результат.
    if (exceedsJsonDepth(body, MAX_STEP_RESULT_DEPTH))
      throw new StepError(
        `http response JSON is nested deeper than ${MAX_STEP_RESULT_DEPTH} levels`,
        false,
      );
    return { status: res.status, body };
  }
}

/** Абсолютний http(s)-URL у межах довжини, яку дозволяє визначення кроку. */
function isValidHttpUrl(url: string): boolean {
  if (url.length > MAX_URL_LENGTH || !URL.canParse(url)) return false;
  const { protocol } = new URL(url);
  return protocol === 'http:' || protocol === 'https:';
}

/**
 * Збій мережі або таймаут. fetch (undici) повідомляє про мережеву помилку як
 * `TypeError('fetch failed')` з причиною в `cause`; помилки в аргументах запиту він кидає з іншим
 * текстом ще до з'єднання.
 */
function isNetworkFailure(err: unknown): boolean {
  // За `name`, а не `instanceof`: помилку створює undici, і її клас може бути з іншого realm
  // (напр., у vm-контексті тестового середовища), ніж глобальні TypeError/DOMException коду.
  if (typeof err !== 'object' || err === null) return false;
  const { name, message } = err as { name?: unknown; message?: unknown };
  return (
    name === 'TimeoutError' ||
    (name === 'TypeError' &&
      (message === 'fetch failed' || message === 'terminated'))
  );
}

/**
 * Порт зі списку заборонених специфікацією fetch (напр., 9, 25, 6667): undici повідомляє про це як
 * про мережеву помилку з причиною `bad port`, але відмова детермінована — повтор нічого не змінить.
 */
function isBlockedPort(err: unknown): boolean {
  const cause = (err as { cause?: { message?: unknown } } | null)?.cause;
  return isNetworkFailure(err) && cause?.message === 'bad port';
}

/**
 * Причина мережевої помилки для тенанта: лише клас збою, без адрес і внутрішнього тексту
 * (`ECONNREFUSED 10.0.0.7:5432` розкривав би інфраструктуру).
 */
function networkReason(err: unknown): string {
  if ((err as { name?: unknown }).name === 'TimeoutError') return 'timed out';
  const code = (err as { cause?: { code?: unknown } }).cause?.code;
  switch (code) {
    case 'ECONNREFUSED':
      return 'connection refused';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'host not found';
    case 'ECONNRESET':
    case 'UND_ERR_SOCKET':
      return 'connection reset';
    case 'UND_ERR_CONNECT_TIMEOUT':
    case 'ETIMEDOUT':
      return 'timed out';
    default:
      return 'network error';
  }
}
