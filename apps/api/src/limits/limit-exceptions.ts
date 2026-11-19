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
