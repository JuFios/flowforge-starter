import type { IncomingMessage } from 'node:http';
import type { Params } from 'nestjs-pino';
import type { Options } from 'pino-http';
import type { LogLevel } from '../config/env.validation';
import {
  correlationIdForRequest,
  getCorrelationId,
  getCorrelationSource,
} from './correlation';

/** Назви полів, значення яких — облікові дані (ТЗ 4). */
const SECRET_FIELDS = [
  'apiKey',
  'webhookSecret',
  'nextWebhookSecret',
  'nextSecret',
  'password',
  'secret',
  'token',
];

/**
 * Шляхи, значення яких ніколи не потрапляють у логи. Заголовки автентифікації й підписи, а також
 * поля з обліковими даними на верхньому, першому й другому рівнях вкладеності будь-якого об'єкта
 * (наприклад, `err.body.secret` помилки або `req.body.apiKey`, якщо тіло колись потрапить у лог).
 */
export const REDACT_PATHS = [
  'req.headers["x-api-key"]',
  'req.headers["x-admin-token"]',
  'req.headers["x-signature"]',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  ...SECRET_FIELDS,
  ...SECRET_FIELDS.map((field) => '*.' + field),
  ...SECRET_FIELDS.map((field) => '*.*.' + field),
];

const QUIET_ROUTES = new Set(['/health', '/ready', '/metrics']);

export function buildPinoHttpOptions(level: LogLevel): Options {
  return {
    level,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    genReqId: (req: IncomingMessage) => correlationIdForRequest(req),
    // У межах HTTP-запиту дочірній логер уже містить correlationId (quietReqLogger),
    // тому mixin додає його лише для фонових контекстів: задач воркера і cron.
    quietReqLogger: true,
    customAttributeKeys: { reqId: 'correlationId' },
    mixin: () => {
      const id = getCorrelationId();
      return id && getCorrelationSource() !== 'http'
        ? { correlationId: id }
        : {};
    },
    customLogLevel: (_req, res, err) =>
      err || res.statusCode >= 500
        ? 'error'
        : res.statusCode >= 400
          ? 'warn'
          : 'info',
    autoLogging: {
      ignore: (req) => QUIET_ROUTES.has((req.url ?? '').split('?')[0]),
    },
  };
}

export function buildLoggerParams(level: LogLevel): Params {
  return { pinoHttp: buildPinoHttpOptions(level) };
}
