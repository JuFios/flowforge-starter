import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { IncomingMessage } from 'node:http';
import { CORRELATION_HEADER, correlationIdForRequest } from './correlation';
import { toSafeError } from './safe-error';

/**
 * Єдина точка формування відповіді про помилку. HttpException віддаються як є
 * (це свідомі повідомлення для клієнта); будь-яка інша помилка — лише загальне
 * повідомлення і correlationId, а деталі (тип, повідомлення, код, стек) — тільки в лог.
 * Сам об'єкт помилки в лог не передається (див. toSafeError).
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionsFilter');

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.adapterHost;
    const http = host.switchToHttp();
    const response = http.getResponse();
    // Із запиту, а не з AsyncLocalStorage: помилка могла виникнути ще до middleware кореляції
    // (наприклад, у body-parser), а ID однаково має повернутися клієнту.
    const correlationId = correlationIdForRequest(http.getRequest<IncomingMessage>());

    let status: number;
    let body: Record<string, unknown>;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const payload = exception.getResponse();
      body = typeof payload === 'string' ? { statusCode: status, message: payload } : { ...(payload as object) };
      if (status >= 500) this.logger.error({ err: toSafeError(exception) }, 'HTTP 5xx exception');
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      body = { statusCode: status, message: 'Internal server error' };
      this.logger.error({ err: toSafeError(exception) }, 'Unhandled exception');
    }

    // Middleware кореляції міг ще не виконатися (помилка body-parser), тож заголовок ставимо й тут.
    httpAdapter.setHeader(response, CORRELATION_HEADER, correlationId);
    httpAdapter.reply(response, { ...body, correlationId }, status);
  }
}
