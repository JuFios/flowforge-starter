import { Injectable, Logger } from '@nestjs/common';
import { StepDefinition } from '../entities';
import { MAX_URL_LENGTH } from '../workflows/definition';
import { renderTemplate, StepContext } from './template';

/**
 * Статуси, після яких запит варто повторити: таймаут запиту (408), «зарано» (425), обмеження
 * частоти (429) і помилки сервера (5xx). Решта 4xx — помилка в самому запиті, повтор її не змінить.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export class StepError extends Error {
  constructor(
    message: string,
    readonly retryable = true,
  ) {
    super(message);
  }
}

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
        this.logger.log(renderTemplate(step.message, ctx));
        return { logged: true };
      case 'delay':
        // Пауза — довговічний таймер у черзі (JobRunnerService), а не очікування в процесі.
        throw new StepError(
          'delay steps are scheduled by the job runner',
          false,
        );
      case 'transform':
        return this.transform(step.expr, ctx);
      case 'http':
        return this.http(step, ctx, signal, idempotencyKey);
    }
  }

  private transform(expr: string, ctx: StepContext): unknown {
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval -- відомий дефект: transform виконує довільний код хоста; виправлення — PR 4 (пісочниця JSONata)
      const fn = new Function('ctx', `return (${expr});`);
      return fn(ctx);
    } catch (err) {
      throw new StepError(`transform: ${(err as Error).message}`, false);
    }
  }

  private async http(
    step: Extract<StepDefinition, { type: 'http' }>,
    ctx: StepContext,
    signal?: AbortSignal,
    idempotencyKey?: string,
  ): Promise<unknown> {
    const url = renderTemplate(step.url, ctx);
    // Підстановка значень із input/steps може зробити URL невалідним (пробіл, задовгий, інша
    // схема). Це помилка даних, а не мережі: повтор дасть той самий URL.
    if (!isValidHttpUrl(url))
      throw new StepError(
        'http url is invalid after template substitution',
        false,
      );
    let res: Response;
    try {
      res = await fetch(url, {
        method: step.method ?? 'GET',
        // Ключ однаковий для всіх спроб кроку: отримувач, що його враховує, виконає ефект один раз.
        headers: idempotencyKey
          ? { ...step.headers, 'Idempotency-Key': idempotencyKey }
          : step.headers,
        body:
          step.body !== undefined ? renderTemplate(step.body, ctx) : undefined,
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
          : AbortSignal.timeout(15_000),
      });
    } catch (err) {
      // Скасування воркером (lease, завершення) — не помилка кроку, передаємо як є.
      if (signal?.aborted) throw err;
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
    const text = await res.text();
    if (!res.ok) {
      throw new StepError(`http ${res.status}`, isRetryableStatus(res.status));
    }
    try {
      return { status: res.status, body: JSON.parse(text) as unknown };
    } catch {
      return { status: res.status, body: text.slice(0, 10_000) };
    }
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
    (name === 'TypeError' && message === 'fetch failed')
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
