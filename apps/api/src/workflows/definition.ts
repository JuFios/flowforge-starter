import { BadRequestException } from '@nestjs/common';
import { StepDefinition } from '../entities';

const STEP_TYPES = ['http', 'transform', 'log', 'delay'] as const;
type StepType = (typeof STEP_TYPES)[number];

export const MAX_STEPS = 50;
/** Розмір усього визначення кроків (JSON), байт. */
export const MAX_DEFINITION_BYTES = 64 * 1024;
export const MAX_URL_LENGTH = 2048;
export const MAX_HEADERS = 50;
export const MAX_HEADER_NAME_LENGTH = 256;
export const MAX_HEADER_VALUE_LENGTH = 8 * 1024;
/** Тіло http-кроку (шаблон), байт. */
export const MAX_HTTP_BODY_BYTES = 32 * 1024;
export const MAX_EXPRESSION_LENGTH = 4096;
export const MAX_LOG_MESSAGE_LENGTH = 4096;
/** Пауза — довговічний таймер у черзі, слота воркера не тримає, тож може бути довгою. */
export const MAX_DELAY_MS = 30 * 24 * 60 * 60 * 1000;

export const HTTP_METHODS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
] as const;

/** Дозволені поля кожного типу кроку; будь-яке інше поле — помилка, а не мовчазне збереження. */
const STEP_FIELDS: Record<StepType, readonly string[]> = {
  http: ['id', 'type', 'url', 'method', 'headers', 'body'],
  transform: ['id', 'type', 'expr'],
  log: ['id', 'type', 'message'],
  delay: ['id', 'type', 'ms'],
};

/** Ім'я заголовка — token за RFC 9110. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Значення без керівних символів (CR/LF дали б змогу вставити власні заголовки). */
const HEADER_VALUE = /^[\t\x20-\x7e\x80-￿]*$/;
/**
 * Заголовки, які тенант не задає: `Idempotency-Key` ставить платформа (стабільний для всіх спроб
 * кроку), а службові заголовки з'єднання визначає HTTP-клієнт.
 */
const RESERVED_HEADERS = new Set([
  'idempotency-key',
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'proxy-connection',
]);

function fail(message: string): never {
  throw new BadRequestException(message);
}

function stringField(
  step: Record<string, unknown>,
  field: string,
  where: string,
  maxLength: number,
): string {
  const value = step[field];
  if (typeof value !== 'string') fail(`${where}.${field} обов'язковий рядок`);
  if (value.length > maxLength)
    fail(`${where}.${field} довший за ${maxLength} символів`);
  return value;
}

function validateHttp(
  step: Record<string, unknown>,
  where: string,
): StepDefinition {
  const url = stringField(step, 'url', where, MAX_URL_LENGTH);
  // Шаблон {{ … }} у шляху чи query дозволений, але схема має бути http(s) уже у визначенні.
  if (!/^https?:\/\//i.test(url))
    fail(`${where}.url має починатися з http:// або https://`);

  let method: string | undefined;
  if (step.method !== undefined) {
    if (
      typeof step.method !== 'string' ||
      !(HTTP_METHODS as readonly string[]).includes(step.method.toUpperCase())
    ) {
      fail(`${where}.method має бути одним із ${HTTP_METHODS.join(', ')}`);
    }
    method = step.method.toUpperCase();
  }

  let headers: Record<string, string> | undefined;
  if (step.headers !== undefined) {
    const raw = step.headers;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
      fail(`${where}.headers має бути об'єктом`);
    const entries = Object.entries(raw as Record<string, unknown>);
    if (entries.length > MAX_HEADERS)
      fail(`${where}.headers: не більше ${MAX_HEADERS} заголовків`);
    headers = {};
    for (const [name, value] of entries) {
      if (name.length > MAX_HEADER_NAME_LENGTH || !HEADER_NAME.test(name))
        fail(`${where}.headers: невалідне ім'я заголовка`);
      if (RESERVED_HEADERS.has(name.toLowerCase()))
        fail(`${where}.headers: заголовок ${name} задає платформа`);
      if (
        typeof value !== 'string' ||
        value.length > MAX_HEADER_VALUE_LENGTH ||
        !HEADER_VALUE.test(value)
      ) {
        fail(
          `${where}.headers.${name}: значення має бути рядком без керівних символів`,
        );
      }
      headers[name] = value;
    }
  }

  let body: string | undefined;
  if (step.body !== undefined) {
    if (typeof step.body !== 'string') fail(`${where}.body має бути рядком`);
    if (Buffer.byteLength(step.body) > MAX_HTTP_BODY_BYTES)
      fail(`${where}.body більший за ${MAX_HTTP_BODY_BYTES} байт`);
    // GET і HEAD не мають тіла (fetch відмовляється надсилати такий запит); метод за
    // замовчуванням — GET.
    const effective = method ?? 'GET';
    if (effective === 'GET' || effective === 'HEAD')
      fail(`${where}.body не дозволений для методу ${effective}`);
    body = step.body;
  }

  return {
    id: step.id as string,
    type: 'http',
    url,
    ...(method !== undefined && { method }),
    ...(headers !== undefined && { headers }),
    ...(body !== undefined && { body }),
  };
}

function validateStep(
  step: Record<string, unknown>,
  where: string,
): StepDefinition {
  const type = step.type as StepType;
  const unknown = Object.keys(step).filter(
    (k) => !STEP_FIELDS[type].includes(k),
  );
  if (unknown.length > 0) fail(`${where}: невідомі поля ${unknown.join(', ')}`);
  const id = step.id as string;
  switch (type) {
    case 'http':
      return validateHttp(step, where);
    case 'transform':
      return {
        id,
        type,
        expr: stringField(step, 'expr', where, MAX_EXPRESSION_LENGTH),
      };
    case 'log':
      return {
        id,
        type,
        message: stringField(step, 'message', where, MAX_LOG_MESSAGE_LENGTH),
      };
    case 'delay':
      if (
        typeof step.ms !== 'number' ||
        !Number.isInteger(step.ms) ||
        step.ms < 0 ||
        step.ms > MAX_DELAY_MS
      ) {
        fail(`${where}.ms має бути цілим числом 0..${MAX_DELAY_MS}`);
      }
      return { id, type, ms: step.ms };
  }
}

/**
 * Валідує масив кроків і повертає його нормалізованим (лише відомі поля, метод у верхньому
 * регістрі). Кидає BadRequestException з поясненням для тенанта.
 */
export function validateSteps(raw: unknown): StepDefinition[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_STEPS) {
    fail(`steps має бути масивом від 1 до ${MAX_STEPS} елементів`);
  }
  if (Buffer.byteLength(JSON.stringify(raw)) > MAX_DEFINITION_BYTES) {
    fail(`steps більший за ${MAX_DEFINITION_BYTES} байт`);
  }
  const seen = new Set<string>();
  return raw.map((s: unknown, i) => {
    const where = `steps[${i}]`;
    if (typeof s !== 'object' || s === null || Array.isArray(s))
      fail(`${where} має бути об'єктом`);
    const step = s as Record<string, unknown>;
    if (typeof step.id !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(step.id))
      fail(`${where}.id невалідний`);
    if (seen.has(step.id)) fail(`Дубльований id кроку: ${step.id}`);
    seen.add(step.id);
    if (!STEP_TYPES.includes(step.type as StepType))
      fail(`${where}.type невідомий`);
    return validateStep(step, where);
  });
}
