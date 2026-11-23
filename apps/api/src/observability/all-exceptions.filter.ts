import {
  BadRequestException,
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { IncomingMessage, STATUS_CODES } from 'node:http';
import {
  CORRELATION_HEADER,
  correlationIdForRequest,
  getCorrelationId,
} from './correlation';
import { toSafeError } from './safe-error';

/** Заміна помилки до того, як Nest збереже повідомлення парсера в BadRequestException. */
export function sanitizeJsonParseError(
  error: unknown,
  _request: unknown,
  _response: unknown,
  next: (error: unknown) => void,
): void {
  if (
    error instanceof SyntaxError &&
    (error as { type?: unknown }).type === 'entity.parse.failed'
  ) {
    next(new BadRequestException('Невалідний JSON'));
    return;
  }
  next(error);
}

/**
 * Помилки з http-errors (body-parser: 413 завелике тіло, 415 кодування/кодова сторінка тощо)
 * не є HttpException, але несуть клієнтський статус 4xx у `status` / `statusCode`.
 */
function clientErrorStatus(err: unknown): number | undefined {
  if (!(err instanceof Error)) return undefined;
  const { status, statusCode } = err as {
    status?: unknown;
    statusCode?: unknown;
  };
  const value = status ?? statusCode;
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 400 &&
    value < 500
    ? value
    : undefined;
}

/**
 * Єдина точка формування відповіді про помилку. HttpException віддаються як є
 * (це свідомі повідомлення для клієнта); помилки body-parser — їхній статус 4xx зі стандартним
 * текстом статусу; будь-яка інша помилка — лише загальне
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
    const response = http.getResponse<unknown>();
    // Із запиту, а не з AsyncLocalStorage: помилка могла виникнути ще до middleware кореляції
    // (наприклад, у body-parser), а ID однаково має повернутися клієнту.
    const correlationId = correlationIdForRequest(
      http.getRequest<IncomingMessage>(),
    );

    // Якщо помилка виникла до middleware кореляції, логер ще не знає ID — додаємо його явно,
    // щоб запис у лозі збігався з тим, що отримав клієнт.
    const logContext =
      getCorrelationId() === correlationId ? {} : { correlationId };
    // Ключ `error`, а не `err`: серіалізатор pino для `err` переписує тип на "Object".
    let status: number;
    let body: Record<string, unknown>;
    const clientStatus = clientErrorStatus(exception);

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const payload = exception.getResponse();
      body =
        typeof payload === 'string'
          ? { statusCode: status, message: payload }
          : { ...payload };
      if (status >= 500) {
        this.logger.error(
          { ...logContext, status, error: toSafeError(exception) },
          'HTTP 5xx exception',
        );
      } else if ('correlationId' in logContext) {
        // Відхилено до middleware (напр., невалідний JSON): pino-http такий запит не логує.
        this.logger.warn(
          { ...logContext, status, error: toSafeError(exception) },
          'Request rejected before the handler',
        );
      }
    } else if (clientStatus !== undefined) {
      status = clientStatus;
      body = {
        statusCode: status,
        message: STATUS_CODES[status] ?? 'Bad Request',
      };
      this.logger.warn(
        { ...logContext, status, error: toSafeError(exception) },
        'Request rejected before the handler',
      );
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      body = { statusCode: status, message: 'Internal server error' };
      this.logger.error(
        { ...logContext, status, error: toSafeError(exception) },
        'Unhandled exception',
      );
    }

    // Middleware кореляції міг ще не виконатися (помилка body-parser), тож заголовок ставимо й тут.
    httpAdapter.setHeader(response, CORRELATION_HEADER, correlationId);
    httpAdapter.reply(response, { ...body, correlationId }, status);
  }
}
