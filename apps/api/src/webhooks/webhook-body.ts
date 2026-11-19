import {
  BadRequestException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { Request } from 'express';
import { parseRunInput } from '../executions/run-input.pipe';

const JSON_UTF8 =
  /^application\/json(?:\s*;\s*charset\s*=\s*(?:"utf-8"|utf-8))?$/i;

/**
 * Вхід виконання з уже автентифікованих сирих байтів webhook-а (README 3.3.7): лише UTF-8 JSON;
 * нуль байтів — порожній вхід, JSON null чи не-об'єкт — 400.
 */
export function parseWebhookBody(req: Request): Record<string, unknown> {
  if (!JSON_UTF8.test(req.headers['content-type'] ?? ''))
    throw new UnsupportedMediaTypeException();
  const bytes: unknown = req.body;
  if (!Buffer.isBuffer(bytes) || !bytes.length) return parseRunInput({});
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new BadRequestException('Невалідний UTF-8 JSON');
  }
  if (body === null)
    throw new BadRequestException(
      "Вхідні дані виконання мають бути JSON-об'єктом",
    );
  return parseRunInput(body);
}
