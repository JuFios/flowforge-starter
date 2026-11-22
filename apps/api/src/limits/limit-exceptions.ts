import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Черга тенанта заповнена (ліміт незавершених задач): нове виконання не створено. Без
 * `Retry-After`: момент, коли звільниться місце, залежить від завершення задач і невідомий.
 */
export class QueueFullException extends HttpException {
  constructor(limit: number) {
    super(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: 'queue_full',
        message: `черга тенанта заповнена: не більше ${limit} незавершених задач; повторіть, коли задачі завершаться`,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/** Перевищено частоту запитів; `Retry-After` (секунди до кінця вікна) ставить той, хто кидає. */
export class RateLimitedException extends HttpException {
  constructor(retryAfterSeconds: number) {
    super(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: 'rate_limited',
        message: `забагато запитів; повторіть через ${retryAfterSeconds} с`,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/**
 * Квота збережених workflow тенанта вичерпана: новий workflow не створено. Без `Retry-After`, як
 * `queue_full`: місце звільняє лише видалення наявного workflow.
 */
export class WorkflowLimitException extends HttpException {
  constructor(limit: number) {
    super(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: 'workflow_limit_reached',
        message: `досягнуто квоти тенанта: не більше ${limit} workflow; видаліть непотрібні workflow, щоб створити новий`,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/**
 * Квота outbox тенанта вичерпана: недоставлені події разом із живими виконаннями досягли
 * `maxOutboxEvents`. Нове виконання не створено, прийняті події лишаються й доставляються. Без
 * `Retry-After`: місце звільняє завершення без нової події, доставка або явний `discard`.
 */
export class OutboxFullException extends HttpException {
  constructor(limit: number, undelivered: number) {
    const action =
      undelivered === 0
        ? 'Дочекайтеся завершення виконань. Якщо вони створять сповіщення, місце звільниться після їх доставки або скасування.'
        : 'Відновіть доставку або скасуйте недоставлені події. Якщо квоту ще займають виконання, дочекайтеся їх завершення.';
    super(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: 'outbox_full',
        message: `Квота сповіщень заповнена. Ліміт для недоставлених подій і незавершених виконань — ${limit}. ${action}`,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/**
 * Тенант уже готує чи отримує стільки знімків `GET /executions/:id`, скільки дозволяє його частка
 * спільного пулу інстансу (DETAIL_MAX_PER_TENANT). `Retry-After` ставить контролер.
 */
export class DetailInProgressException extends HttpException {
  constructor() {
    super(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: 'detail_in_progress',
        message:
          'попередній запит повних деталей виконання ще триває; дочитайте його або повторіть пізніше',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
