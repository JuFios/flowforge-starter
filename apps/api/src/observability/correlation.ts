import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/** Заголовок, через який кореляційний ID приходить у запиті і повертається у відповіді. */
export const CORRELATION_HEADER = 'x-request-id';

/**
 * Звідки взявся контекст: HTTP-запит, задача воркера, спрацювання планувальника чи спроба
 * доставки сповіщення (ID — трасування, що завершило виконання).
 */
export type CorrelationSource = 'http' | 'job' | 'cron' | 'outbox';

interface CorrelationStore {
  correlationId: string;
  source: CorrelationSource;
}

const storage = new AsyncLocalStorage<CorrelationStore>();

/** Дозволяємо лише безпечні символи й обмежену довжину: значення потрапляє в логи й БД. */
const VALID_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function newCorrelationId(): string {
  return randomUUID();
}

/** Повертає ID із заголовка, якщо він валідний; інакше undefined. */
export function normalizeCorrelationId(raw: unknown): string | undefined {
  const value: unknown = Array.isArray(raw) ? (raw as unknown[])[0] : raw;
  return typeof value === 'string' && VALID_ID.test(value) ? value : undefined;
}

const REQUEST_ID = Symbol('correlationId');
type RequestWithId = IncomingMessage & { [REQUEST_ID]?: string };

/**
 * ID для конкретного HTTP-запиту, обчислюється один раз і кешується на об'єкті запиту,
 * тому pino-http і middleware кореляції гарантовано бачать однакове значення.
 */
export function correlationIdForRequest(req: IncomingMessage): string {
  const r = req as RequestWithId;
  r[REQUEST_ID] ??=
    normalizeCorrelationId(req.headers[CORRELATION_HEADER]) ??
    newCorrelationId();
  return r[REQUEST_ID];
}

export function runWithCorrelationId<T>(
  correlationId: string,
  source: CorrelationSource,
  fn: () => T,
): T {
  return storage.run({ correlationId, source }, fn);
}

export function getCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

export function getCorrelationSource(): CorrelationSource | undefined {
  return storage.getStore()?.source;
}
