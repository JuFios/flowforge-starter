import type { IncomingMessage } from 'node:http';
import type { Params } from 'nestjs-pino';
import type { Options } from 'pino-http';
import type { LogLevel } from '../config/env.validation';
import {
  correlationIdForRequest,
  getCorrelationId,
  getCorrelationSource,
} from './correlation';

/**
 * Шляхи, значення яких ніколи не потрапляють у логи. Заголовки автентифікації,
 * підписи, а також типові назви полів із секретами у будь-якому об'єкті першого рівня.
 */
export const REDACT_PATHS = [
  'req.headers["x-api-key"]',
  'req.headers["x-admin-token"]',
  'req.headers["x-signature"]',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'apiKey',
  'webhookSecret',
  'nextWebhookSecret',
  'password',
  'secret',
  'token',
  '*.apiKey',
  '*.webhookSecret',
  '*.nextWebhookSecret',
  '*.password',
  '*.secret',
  '*.token',
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
