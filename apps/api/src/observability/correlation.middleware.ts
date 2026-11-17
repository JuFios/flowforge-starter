import { Injectable, NestMiddleware } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CORRELATION_HEADER, correlationIdForRequest, runWithCorrelationId } from './correlation';

/** Встановлює кореляційний контекст (AsyncLocalStorage) на весь час обробки запиту. */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: IncomingMessage, res: ServerResponse, next: () => void): void {
    const id = correlationIdForRequest(req);
    res.setHeader(CORRELATION_HEADER, id);
    runWithCorrelationId(id, 'http', next);
  }
}
