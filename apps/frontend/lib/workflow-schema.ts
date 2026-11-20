import { parseExpression } from 'cron-parser';
import { z } from 'zod';

/**
 * Клієнтська перевірка визначення workflow — той самий контракт, що й `validateSteps` та DTO на
 * сервері (`apps/api/src/workflows/definition.ts`, `dto/workflow.dto.ts`). Відповідність
 * перевіряє тест паритету на справжньому API (test/contract.spec.ts): для кожного прикладу
 * вердикт zod збігається з відповіддю API. Профіль виразу JSONata перевіряє лише сервер —
 * для цього потрібен сам рушій; його помилка показується біля поля виразу.
 */
export const LIMITS = {
  maxSteps: 50,
  maxDefinitionBytes: 64 * 1024,
  maxUrlLength: 2048,
  maxHeaders: 50,
  maxHeaderNameLength: 256,
  maxHeaderValueLength: 8 * 1024,
  maxHttpBodyBytes: 32 * 1024,
  maxExpressionLength: 4096,
  maxLogMessageLength: 4096,
  maxDelayMs: 30 * 24 * 60 * 60 * 1000,
  maxNameLength: 200,
  maxCronLength: 100,
  maxTimezoneLength: 64,
  maxRunInputBytes: 64 * 1024,
} as const;

export const HTTP_METHODS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
] as const;
export const STEP_TYPES = ['http', 'transform', 'log', 'delay'] as const;
export const MISSED_RUN_POLICIES = ['skip', 'run_once', 'run_all'] as const;
export type StepType = (typeof STEP_TYPES)[number];
export type MissedRunPolicy = (typeof MISSED_RUN_POLICIES)[number];

/** Заголовки, які задає платформа (`RESERVED_HEADERS` на сервері). */
export const RESERVED_HEADERS = new Set([
  'idempotency-key',
  'host',
  'x-request-id',
  'accept-encoding',
  'proxy-authorization',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'proxy-connection',
]);

const STEP_ID = /^[a-z][a-z0-9_]{0,31}$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;
const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;
const CRON_ALIAS = /^@(yearly|monthly|weekly|daily|hourly)$/;
/** U+0000 і одиночні сурогати Postgres не зберігає (`findUnstorable` на сервері). */
const UNSTORABLE =
  // eslint-disable-next-line no-control-regex -- U+0000 і є символом, який треба знайти
  /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const encoder = new TextEncoder();
export const byteLength = (text: string) => encoder.encode(text).length;

/** Чи є серед ключів і рядкових значень текст, якого Postgres не збереже. */
function hasUnstorable(value: unknown): boolean {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const item = stack.pop();
    if (typeof item === 'string') {
      if (UNSTORABLE.test(item)) return true;
    } else if (Array.isArray(item)) stack.push(...(item as unknown[]));
    else if (item && typeof item === 'object')
      for (const [key, inner] of Object.entries(item)) {
        if (UNSTORABLE.test(key)) return true;
        stack.push(inner);
      }
  }
  return false;
}

const storable = (field: z.ZodString) =>
  field.refine((v) => !UNSTORABLE.test(v), {
    message: 'містить U+0000 або некоректний Unicode',
  });

/** Збережене значення заголовка лишається без змін (`{ keep: true }` у PATCH). */
export const KEEP = { keep: true } as const;
export type HeaderValue = string | typeof KEEP;

const headerValue = z.union([
  z
    .string()
    .max(
      LIMITS.maxHeaderValueLength,
      `не довше ${LIMITS.maxHeaderValueLength} символів`,
    )
    .regex(
      HEADER_VALUE,
      'лише байти до 0xFF, без керівних символів, крім табуляції',
    ),
  z.object({ keep: z.literal(true) }).strict(),
]);

const httpStep = z
  .object({
    id: z.string(),
    type: z.literal('http'),
    url: z
      .string({ required_error: "обов'язкове поле" })
      .max(LIMITS.maxUrlLength, `не довше ${LIMITS.maxUrlLength} символів`)
      .regex(/^https?:\/\//i, 'має починатися з http:// або https://'),
    method: z.enum(HTTP_METHODS).optional(),
    headers: z
      .record(headerValue)
      .optional()
      .superRefine((headers, ctx) => {
        if (!headers) return;
        const names = Object.keys(headers);
        if (names.length > LIMITS.maxHeaders)
          ctx.addIssue({
            code: 'custom',
            message: `не більше ${LIMITS.maxHeaders} заголовків`,
          });
        const seen = new Set<string>();
        for (const name of names) {
          const lower = name.toLowerCase();
          if (
            name.length > LIMITS.maxHeaderNameLength ||
            !HEADER_NAME.test(name)
          )
            ctx.addIssue({
              code: 'custom',
              path: [name],
              message: 'невалідне ім’я заголовка',
            });
          else if (RESERVED_HEADERS.has(lower))
            ctx.addIssue({
              code: 'custom',
              path: [name],
              message: `заголовок ${name} задає платформа`,
            });
          else if (seen.has(lower))
            ctx.addIssue({
              code: 'custom',
              path: [name],
              message: 'заголовок з такою назвою вже є (регістр не важливий)',
            });
          seen.add(lower);
        }
      }),
    body: z
      .string()
      .refine(
        (v) => byteLength(v) <= LIMITS.maxHttpBodyBytes,
        `не більше ${LIMITS.maxHttpBodyBytes} байт`,
      )
      .optional(),
  })
  .strict();

const transformStep = z
  .object({
    id: z.string(),
    type: z.literal('transform'),
    expr: z
      .string({ required_error: "обов'язкове поле" })
      .max(
        LIMITS.maxExpressionLength,
        `не довше ${LIMITS.maxExpressionLength} символів`,
      ),
    language: z.literal('jsonata-v1').optional(),
  })
  .strict();

const logStep = z
  .object({
    id: z.string(),
    type: z.literal('log'),
    message: z
      .string({ required_error: "обов'язкове поле" })
      .max(
        LIMITS.maxLogMessageLength,
        `не довше ${LIMITS.maxLogMessageLength} символів`,
      ),
  })
  .strict();

const delayStep = z
  .object({
    id: z.string(),
    type: z.literal('delay'),
    ms: z
      .number({ invalid_type_error: 'ціле число мілісекунд' })
      .int('ціле число мілісекунд')
      .min(0, 'не менше 0')
      .max(LIMITS.maxDelayMs, `не більше ${LIMITS.maxDelayMs} мс (30 днів)`),
  })
  .strict();

export const stepSchema = z
  .discriminatedUnion('type', [httpStep, transformStep, logStep, delayStep])
  .superRefine((step, ctx) => {
    if (step.type !== 'http') return;
    const method = step.method ?? 'GET';
    if (step.body !== undefined && (method === 'GET' || method === 'HEAD'))
      ctx.addIssue({
        code: 'custom',
        path: ['body'],
        message: `тіло не дозволене для методу ${method}`,
      });
  });
export type StepPayload = z.infer<typeof stepSchema>;

export const stepsSchema = z
  .array(stepSchema)
  .min(1, 'потрібен хоча б один крок')
  .max(LIMITS.maxSteps, `не більше ${LIMITS.maxSteps} кроків`)
  .superRefine((steps, ctx) => {
    const seen = new Set<string>();
    steps.forEach((step, i) => {
      if (!STEP_ID.test(step.id))
        ctx.addIssue({
          code: 'custom',
          path: [i, 'id'],
          message:
            'латинські малі літери, цифри й «_», починається з літери, до 32 символів',
        });
      else if (seen.has(step.id))
        ctx.addIssue({
          code: 'custom',
          path: [i, 'id'],
          message: 'id кроку вже використано',
        });
      seen.add(step.id);
    });
    const json = JSON.stringify(steps);
    if (byteLength(json) > LIMITS.maxDefinitionBytes)
      ctx.addIssue({
        code: 'custom',
        message: `визначення більше за ${LIMITS.maxDefinitionBytes} байт`,
      });
    if (hasUnstorable(steps))
      ctx.addIssue({
        code: 'custom',
        message: 'визначення містить U+0000 або некоректний Unicode',
      });
  });

export function isValidTimeZone(zone: string): boolean {
  if (zone.length > LIMITS.maxTimezoneLength || !ZONE_NAME.test(zone))
    return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Розклад: та сама форма, що й `CronSchedule.parse` (5–6 полів або псевдонім). */
export function cronProblem(cron: string): string | undefined {
  const source = cron.trim();
  if (source === '') return 'вираз порожній';
  if (cron.length > LIMITS.maxCronLength)
    return `не довше ${LIMITS.maxCronLength} символів`;
  const fields = source.split(/\s+/).length;
  if (fields !== 5 && fields !== 6 && !CRON_ALIAS.test(source))
    return 'потрібно 5 або 6 полів або псевдонім (@hourly, @daily, @weekly, @monthly, @yearly)';
  try {
    parseExpression(source, { tz: 'UTC' }).next();
  } catch {
    return 'невірний вираз cron або відсутній наступний момент запуску';
  }
  return undefined;
}

const name = storable(
  z
    .string({ required_error: "обов'язкове поле" })
    .min(1, "обов'язкове поле")
    .max(LIMITS.maxNameLength, `не довше ${LIMITS.maxNameLength} символів`),
);

const schedule = {
  cron: z
    .string()
    .nullable()
    .optional()
    .superRefine((cron, ctx) => {
      if (cron === null || cron === undefined) return;
      const problem = cronProblem(cron);
      if (problem) ctx.addIssue({ code: 'custom', message: problem });
    }),
  timezone: z
    .string()
    .min(1, "обов'язкове поле")
    .max(LIMITS.maxTimezoneLength)
    .refine(isValidTimeZone, 'невідома зона IANA (наприклад, Europe/Kyiv)')
    .optional(),
  enabled: z.boolean().optional(),
  missedRunPolicy: z.enum(MISSED_RUN_POLICIES).optional(),
};

/** Тіло POST /workflows: `keep` у кроках не дозволений. */
export const createWorkflowSchema = z
  .object({ name, steps: stepsSchema, ...schedule })
  .strict()
  .superRefine((wf, ctx) => {
    wf.steps.forEach((step, i) => {
      if (step.type !== 'http' || !step.headers) return;
      for (const [header, value] of Object.entries(step.headers))
        if (typeof value !== 'string')
          ctx.addIssue({
            code: 'custom',
            path: ['steps', i, 'headers', header],
            message: 'збережене значення можна лишити лише під час редагування',
          });
    });
  });

/** Тіло PATCH /workflows/:id: усі поля необов'язкові, `keep` дозволений. */
export const updateWorkflowSchema = z
  .object({ name: name.optional(), steps: stepsSchema.optional(), ...schedule })
  .strict();

export type CreateWorkflowPayload = z.infer<typeof createWorkflowSchema>;
export type UpdateWorkflowPayload = z.infer<typeof updateWorkflowSchema>;

/** Шлях помилки у формі: `steps.2.headers.Authorization`, `cron`, `name`. */
export function issuePath(path: ReadonlyArray<string | number>): string {
  return path.join('.');
}

/** Вхід запуску: JSON-об'єкт до 64 КіБ. */
export function parseRunInput(
  text: string,
): { ok: true; source: string } | { ok: false; error: string } {
  const source = text.trim() === '' ? '{}' : text;
  if (byteLength(source) > LIMITS.maxRunInputBytes)
    return {
      ok: false,
      error: `вхід більший за ${LIMITS.maxRunInputBytes} байт`,
    };
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return { ok: false, error: 'невалідний JSON' };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return { ok: false, error: 'вхід має бути JSON-об’єктом' };
  return { ok: true, source };
}
