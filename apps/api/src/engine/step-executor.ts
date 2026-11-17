import { Injectable, Logger } from '@nestjs/common';
import { StepDefinition } from '../entities';
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

/**
 * Причина мережевої помилки для тенанта: лише клас збою, без адрес і внутрішнього тексту
 * (`ECONNREFUSED 10.0.0.7:5432` розкривав би інфраструктуру).
 */
function networkReason(err: unknown): string {
  if (err instanceof DOMException && err.name === 'TimeoutError')
    return 'timed out';
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
