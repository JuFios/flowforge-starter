import {
  BadRequestException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  findInexactNumber,
  inexactNumberMessage,
} from '../common/json-numbers';
import { parseRunInput } from '../executions/run-input.pipe';

const JSON_UTF8 =
  /^application\/json(?:\s*;\s*charset\s*=\s*(?:"utf-8"|utf-8))?$/i;

/**
 * Вхід виконання з уже автентифікованих сирих байтів нової доставки (README 3.3.7): лише UTF-8
 * JSON; нуль байтів — порожній вхід, JSON null чи не-об'єкт — 400, інший тип чи кодування — 415.
 */
export function parseWebhookBody(req: Request): Record<string, unknown> {
  if (!JSON_UTF8.test(req.headers['content-type'] ?? ''))
    throw new UnsupportedMediaTypeException();
  const bytes: unknown = req.body;
  if (!Buffer.isBuffer(bytes) || !bytes.length) return parseRunInput({});
  let text: string;
  let body: unknown;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    body = JSON.parse(text);
  } catch {
    throw new BadRequestException('Невалідний UTF-8 JSON');
  }
  // Підписані байти мають означати те саме, що отримає виконання: число, яке змінилося б після
  // розбору (1e400, ціле поза точністю double), — 400, а не інший вхід.
  const inexact = findInexactNumber(text);
  if (inexact) throw new BadRequestException(inexactNumberMessage(inexact));
  if (body === null)
    throw new BadRequestException(
      "Вхідні дані виконання мають бути JSON-об'єктом",
    );
  return parseRunInput(body);
}
