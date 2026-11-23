import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import {
  HTTP_METHODS,
  MAX_STEPS,
  MAX_DELAY_MS,
  MAX_HEADERS,
  MAX_EXPRESSION_LENGTH,
  MAX_LOG_MESSAGE_LENGTH,
  MAX_URL_LENGTH,
  MAX_HEADER_VALUE_LENGTH,
} from '../workflows/definition';
import { LIMIT_BOUNDS, OVERRIDE_BOUNDS } from '../tenancy/limits';
import { EVENT_STATUSES } from '../notifications/notifications.dto';

export const str: SchemaObject = { type: 'string' };
export const integer: SchemaObject = { type: 'integer' };
const bool: SchemaObject = { type: 'boolean' };
export const uuid: SchemaObject = { type: 'string', format: 'uuid' };
const date: SchemaObject = { type: 'string', format: 'date-time' };
/** Довільне значення JSON, зокрема `null` (вихід ще не обчислено або крок повернув null). */
const anyJson: SchemaObject = { nullable: true };
export const nullable = (schema: SchemaObject): SchemaObject => ({
  ...schema,
  nullable: true,
});
export const choice = (values: readonly string[]): SchemaObject => ({
  type: 'string',
  enum: [...values],
});
export const object = (
  properties: Record<string, SchemaObject>,
  required = Object.keys(properties),
): SchemaObject => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
});
export const array = (items: SchemaObject): SchemaObject => ({
  type: 'array',
  items,
});
export const ref = (name: string): SchemaObject =>
  ({ $ref: '#/components/schemas/' + name }) as SchemaObject;
const closed = (
  properties: Record<string, SchemaObject>,
  required?: string[],
): SchemaObject => ({
  ...object(properties, required),
  additionalProperties: false,
});
/** Схема з описом поля для Swagger UI. */
const about = (schema: SchemaObject, description: string): SchemaObject => ({
  ...schema,
  description,
});
const marker = (key: string, description: string) =>
  closed({ [key]: about({ type: 'boolean', enum: [true] }, description) });
const text = (maxLength: number): SchemaObject => ({
  type: 'string',
  maxLength,
});
export const status = choice(['pending', 'running', 'succeeded', 'failed']);
export const eventStatus = choice(EVENT_STATUSES);
const types = ['http', 'log', 'transform', 'delay'];
const stepId = { ...str, pattern: '^[a-z][a-z0-9_]{0,31}$' };
const rawHeader = text(MAX_HEADER_VALUE_LENGTH);
const STEPS_TEXT = {
  create: 'Кроки процесу, що виконуються по черзі',
  update:
    'Нові кроки процесу. Замість значення заголовка {"keep": true} лишає збережене значення (лише з актуальною editRevision і без зміни ID чи URL кроку)',
  read: 'Кроки процесу. Значення заголовків не повертаються: замість них маркер {"stored": true}',
};
function steps(mode: 'create' | 'update' | 'read'): SchemaObject {
  const value =
    mode === 'read'
      ? marker('stored', 'Значення збережене, але API його не повертає')
      : mode === 'update'
        ? {
            oneOf: [
              rawHeader,
              marker('keep', 'Лишити збережене значення заголовка без змін'),
            ],
          }
        : rawHeader;
  const step = (
    type: string,
    props: Record<string, SchemaObject>,
    required: string[],
  ) =>
    closed(
      {
        id: about(stepId, 'ID кроку, унікальний у процесі'),
        type: about(choice([type]), 'Тип кроку'),
        ...props,
      },
      ['id', 'type', ...required],
    );
  return {
    type: 'array',
    minItems: 1,
    maxItems: MAX_STEPS,
    description: STEPS_TEXT[mode],
    items: {
      oneOf: [
        step(
          'http',
          {
            url: about(
              text(MAX_URL_LENGTH),
              'Адреса запиту http:// або https://. Дозволені лише публічні адреси, зокрема після редиректів',
            ),
            method: about(
              choice(HTTP_METHODS),
              'HTTP-метод, за замовчуванням GET',
            ),
            headers: about(
              {
                type: 'object',
                maxProperties: MAX_HEADERS,
                additionalProperties: value,
              },
              'Заголовки запиту. Платформа сама задає Idempotency-Key і x-request-id',
            ),
            body: about(str, 'Тіло запиту; не дозволене для GET і HEAD'),
          },
          ['url'],
        ),
        step(
          'log',
          {
            message: about(
              text(MAX_LOG_MESSAGE_LENGTH),
              'Текст запису; підтримує шаблон {{ input.назва }}',
            ),
          },
          ['message'],
        ),
        step(
          'transform',
          {
            expr: about(
              text(MAX_EXPRESSION_LENGTH),
              'Вираз JSONata з обмеженого профілю (README, 3.3.6)',
            ),
            language: about(
              choice(['jsonata-v1']),
              'Мова виразу, за замовчуванням jsonata-v1',
            ),
          },
          ['expr'],
        ),
        step(
          'delay',
          {
            ms: about(
              { type: 'integer', minimum: 0, maximum: MAX_DELAY_MS },
              'Пауза в мілісекундах, до 30 днів; переживає перезапуск і не тримає воркер',
            ),
          },
          ['ms'],
        ),
      ],
    },
  };
}
const definition = {
  name: about({ ...text(200), minLength: 1 }, 'Назва процесу'),
  enabled: about(bool, 'Чи увімкнено процес'),
  cron: about(
    nullable(text(100)),
    'Розклад cron (5 або 6 полів чи @hourly, @daily, @weekly, @monthly, @yearly); null — без розкладу',
  ),
  timezone: about(
    text(64),
    'Зона IANA, у якій обчислюється розклад, напр. Europe/Kyiv',
  ),
  missedRunPolicy: about(
    choice(['skip', 'run_once', 'run_all']),
    'Що робити з моментами розкладу, пропущеними під час простою: пропустити, виконати один раз або виконати всі',
  ),
};
const created = about(date, 'Час створення');
const finished = about(
  nullable(date),
  'Час завершення; null, поки не завершено',
);
const correlation = about(
  nullable(str),
  'Кореляційний ID для пошуку в журналах',
);
const workflow = {
  id: about(uuid, 'ID процесу'),
  ...definition,
  version: about(integer, 'Версія кроків; зростає лише зі зміною кроків'),
  nextFireAt: about(
    nullable(date),
    'Наступний момент розкладу; null без розкладу або до першого обчислення',
  ),
  scheduleBlockedSince: about(
    nullable(date),
    'З якого моменту спрацювання розкладу відкладене через ліміти тенанта; null, якщо не відкладене',
  ),
  scheduleError: about(nullable(str), 'Остання помилка розкладу або null'),
  createdAt: created,
};
const editRevision = {
  ...str,
  pattern: '^[1-9][0-9]{0,18}$',
  description:
    'Ревізія редагованої конфігурації, незалежна від версії кроків і стану планувальника',
};
const run = {
  id: about(uuid, 'ID виконання'),
  workflowId: about(uuid, 'ID процесу'),
  status: about(status, 'Стан виконання'),
  trigger: about(
    choice(['api', 'cron', 'webhook']),
    'Що запустило виконання: API, розклад чи вхідний webhook',
  ),
  createdAt: created,
  finishedAt: finished,
  scheduledAt: about(
    nullable(date),
    'Момент розкладу для запуску за cron; null для інших запусків',
  ),
  correlationId: correlation,
  error: about(nullable(str), 'Причина помилки; null, якщо її немає'),
};
const listing = {
  ...run,
  workflowName: about(
    nullable(str),
    'Поточна назва процесу; null, якщо процес видалено',
  ),
  workflowVersion: about(
    nullable(integer),
    'Версія кроків, з якою працює виконання',
  ),
};
const tenantId = about(uuid, 'ID тенанта');
const execution = {
  ...run,
  tenantId,
  workflowVersionId: about(
    nullable(uuid),
    'ID знімка версії процесу, зафіксованого на момент запуску',
  ),
  input: about(
    { type: 'object', additionalProperties: true },
    'Вхідні дані запуску',
  ),
  output: about(anyJson, 'Результат останнього кроку; null до завершення'),
  idempotencyKey: about(
    nullable(str),
    'Idempotency-Key запуску; null, якщо його не передали',
  ),
};
const step = {
  stepIndex: about(integer, 'Номер кроку, від 0'),
  stepId: about(stepId, 'ID кроку з визначення процесу'),
  status: about(choice(['running', 'succeeded', 'failed']), 'Стан кроку'),
  attempts: about(integer, 'Скільки спроб кроку зроблено'),
  error: about(nullable(str), 'Причина помилки кроку; null, якщо її немає'),
  startedAt: about(date, 'Час початку кроку'),
  finishedAt: finished,
  wakeAt: about(
    nullable(date),
    'Момент пробудження кроку delay; null для інших кроків',
  ),
};
const outputBytes = about(
  nullable(integer),
  'Розмір результату в байтах; null, поки результату немає',
);
const stepSummary = { ...step, outputBytes };
const bounds = ([minimum, maximum]: readonly number[]): SchemaObject => ({
  type: 'integer',
  minimum,
  maximum,
});
/** Пояснення лімітів тенанта (README, «Контракт лімітів»). */
const LIMITS_TEXT: Record<string, string> = {
  maxRunning: 'Скільки задач тенанта виконуються одночасно',
  maxConcurrentExecutions: 'Скільки задач тенанта виконуються одночасно',
  maxQueueSize: 'Скільки незавершених задач тенанта може бути в черзі',
  rateLimit: 'Скільки запитів API тенант може зробити за вікно',
  rateWindowMs: 'Вікно ліміту запитів API, мс',
  webhookRateLimit: 'Скільки вхідних webhook-ів тенант може прийняти за вікно',
  webhookRateWindowMs: 'Вікно ліміту webhook-ів, мс',
  maxWorkflows: 'Скільки процесів тенант може зберігати',
  maxOutboxEvents:
    'Скільки недоставлених сповіщень разом із живими виконаннями може мати тенант',
};
const limitField = (name: string, schema: SchemaObject) =>
  about(schema, LIMITS_TEXT[name]);
const overrides = Object.fromEntries(
  Object.entries(OVERRIDE_BOUNDS).map(([name, range]) => [
    name,
    limitField(name, nullable(bounds(range))),
  ]),
);
const limits = object({
  overrides: about(
    object(overrides),
    'Перевизначення тенанта; null — діє значення за замовчуванням',
  ),
  effective: about(
    object({
      ...Object.fromEntries(
        Object.entries(LIMIT_BOUNDS).map(([key, range]) => [
          key,
          limitField(key, bounds(range)),
        ]),
      ),
      webhookRateLimit: limitField(
        'webhookRateLimit',
        bounds(LIMIT_BOUNDS.rateLimit),
      ),
      webhookRateWindowMs: limitField(
        'webhookRateWindowMs',
        bounds(LIMIT_BOUNDS.rateWindowMs),
      ),
    }),
    'Чинні значення з урахуванням перевизначень',
  ),
});
const keyView = object({
  id: about(uuid, 'ID ключа підпису'),
  role: about(
    choice(['current', 'next']),
    'current — чинний ключ; next — новий ключ ротації, що діє разом із чинним',
  ),
});
const settings = {
  url: about(str, 'Endpoint отримувача сповіщень'),
  enabled: about(
    bool,
    'Чи надсилати сповіщення; вимкнення ставить доставку на паузу, події не губляться',
  ),
  revision: about(
    integer,
    'Ревізія налаштувань; зростає зі зміною адреси чи ввімкненням',
  ),
  keys: about(array(keyView), 'Ключі підпису сповіщень'),
};
const event = {
  id: about(uuid, 'ID події; однаковий у кожній спробі доставки'),
  executionId: about(uuid, 'ID виконання'),
  sequence: about(integer, 'Номер циклу завершення виконання'),
  type: about(str, 'Тип події, напр. execution.succeeded'),
  status: about(eventStatus, 'Стан доставки'),
  attempts: about(integer, 'Скільки спроб доставки зроблено'),
  nextAttemptAt: about(
    nullable(date),
    'Час наступної спроби для pending; null в інших станах',
  ),
  lastError: about(nullable(str), 'Причина останньої невдалої спроби або null'),
  lastStatus: about(nullable(integer), 'HTTP-статус останньої спроби або null'),
  correlationId: correlation,
  createdAt: created,
  deliveredAt: about(nullable(date), 'Час доставки; null, поки не доставлено'),
};
const attempt = object({
  attempt: about(integer, 'Номер спроби'),
  senderId: about(str, 'Відправник, що робив спробу'),
  revision: about(
    nullable(integer),
    'Ревізія налаштувань, з якою йшла спроба; null, якщо налаштування ще не прочитано',
  ),
  keyIds: about(
    nullable(array(uuid)),
    'ID ключів, якими підписано спробу; null, якщо спроба не дійшла до підпису',
  ),
  startedAt: about(date, 'Час початку спроби'),
  finishedAt: about(nullable(date), 'Час завершення спроби; null, поки триває'),
  outcome: about(
    nullable(str),
    'Результат спроби, напр. delivered, http_error, timeout; null, поки триває',
  ),
  httpStatus: about(nullable(integer), 'HTTP-статус відповіді або null'),
  durationMs: about(nullable(integer), 'Тривалість спроби, мс, або null'),
});
const page = (name: string) =>
  object({
    items: about(array(ref(name)), 'Елементи сторінки'),
    nextCursor: about(
      nullable(str),
      'Курсор наступної сторінки; null на останній',
    ),
  });
const errorFields = {
  statusCode: about(integer, 'HTTP-статус'),
  error: about(str, 'Код або назва помилки'),
  message: about(
    { oneOf: [str, array(str)] },
    'Пояснення або перелік помилок валідації',
  ),
  correlationId: about(str, 'Кореляційний ID для пошуку в журналах'),
};
/** Тіло відмови `429` маршруту: `error` — лише коди, які маршрут повертає. */
export const limitError = (codes: readonly string[]): SchemaObject =>
  object(
    {
      ...errorFields,
      error: about(choice(codes), 'Код відмови ліміту цього маршруту'),
    },
    ['statusCode', 'error', 'message'],
  );
const secretOnce = (what: string) =>
  about(str, `${what}; показується лише в цій відповіді`);
export const schemas: Record<string, SchemaObject> = {
  Error: object(errorFields, ['statusCode', 'message']),
  CreateWorkflow: closed({ ...definition, steps: steps('create') }, [
    'name',
    'steps',
  ]),
  UpdateWorkflow: closed(
    { ...definition, editRevision, steps: steps('update') },
    [],
  ),
  Workflow: object({
    ...workflow,
    editRevision,
    tenantId,
    scheduleCursor: about(date, 'Момент, до якого розклад уже оброблено'),
    steps: steps('read'),
  }),
  WorkflowSummary: object(workflow),
  WorkflowPage: page('WorkflowSummary'),
  Execution: object(execution),
  ExecutionListItem: object(listing),
  ExecutionPage: page('ExecutionListItem'),
  ExecutionSummary: object({
    ...listing,
    revision: about(
      { ...str, pattern: '^[0-9]+$' },
      'Ревізія знімка; знімок з більшою ревізією новіший',
    ),
    terminalCycles: about(
      { ...integer, minimum: 0, maximum: 2_147_483_647 },
      'Скільки разів виконання завершувалося; передається в expectedTerminalCycle',
    ),
    plan: about(
      array(
        object({
          id: about(stepId, 'ID кроку'),
          type: about(choice(types), 'Тип кроку'),
        }),
      ),
      'Кроки зі знімка версії процесу',
    ),
    steps: about(array(object(stepSummary)), 'Стан кроків без результатів'),
    inputBytes: about(integer, 'Розмір вхідних даних у байтах'),
    outputBytes,
  }),
  ExecutionDetail: object({
    ...execution,
    steps: about(
      array(
        object({
          ...step,
          id: about(uuid, 'ID запису кроку'),
          executionId: about(uuid, 'ID виконання'),
          tenantId,
          idempotencyKey: about(
            str,
            'Idempotency-Key, який отримує HTTP-отримувач; однаковий для всіх спроб кроку',
          ),
          output: about(anyJson, 'Результат кроку; null, поки його немає'),
        }),
      ),
      'Кроки з результатами',
    ),
  }),
  StepDetail: object({
    ...stepSummary,
    output: about(anyJson, 'Результат кроку; null, поки його немає'),
  }),
  Output: object({
    output: about(anyJson, 'Результат виконання; null до завершення'),
  }),
  ExecutionId: object({ executionId: about(uuid, 'ID виконання') }),
  WebhookAccepted: object({
    executionId: about(
      uuid,
      'ID виконання доставки; повтор тієї самої доставки повертає той самий ID',
    ),
    executionPurged: about(
      bool,
      'true — історію цього виконання вже очищено (EXECUTION_RETENTION_DAYS): повтор прийнято без нового виконання, а GET за цим ID поверне 404',
    ),
  }),
  RunInput: {
    type: 'object',
    additionalProperties: true,
    description: 'Вхідні дані запуску: довільний JSON-об’єкт до 64 КіБ',
    example: { order: 'demo' },
  },
  Limits: limits,
  LimitsPatch: closed(overrides, []),
  CreateTenant: closed(
    {
      name: about({ ...text(200), minLength: 2 }, 'Назва тенанта'),
      limits: ref('LimitsPatch'),
    },
    ['name'],
  ),
  TenantCredentials: object({
    id: tenantId,
    name: about(str, 'Назва тенанта'),
    apiKey: secretOnce('API-ключ тенанта'),
    webhookSecret: secretOnce('Секрет підпису вхідних webhook-ів'),
    webhookKeyId: about(uuid, 'ID ключа підпису вхідних webhook-ів'),
    limits: about(limits, 'Ліміти тенанта'),
  }),
  Session: object({
    token: about(str, 'Токен браузерної сесії'),
    expiresAt: about(date, 'Коли сесія спливе'),
  }),
  Ticket: object({
    ticket: about(str, 'Одноразовий тикет для /realtime'),
    expiresAt: about(date, 'Коли тикет спливе'),
  }),
  SigningKeys: array(keyView),
  NewKey: object({
    id: about(uuid, 'ID нового ключа'),
    secret: secretOnce('Секрет нового ключа'),
  }),
  Discarded: object({
    discarded: about(integer, 'Скільки подій скасовано'),
  }),
  Settings: object(settings),
  SettingsResult: object(
    {
      ...settings,
      secret: secretOnce('Секрет підпису сповіщень (лише в першому PUT)'),
    },
    Object.keys(settings),
  ),
  SettingsInput: closed(
    {
      url: about(
        text(MAX_URL_LENGTH),
        'Endpoint отримувача: https-адреса публічного хоста без облікових даних',
      ),
      enabled: about(bool, 'Чи надсилати сповіщення; за замовчуванням true'),
    },
    ['url'],
  ),
  Event: object(event),
  EventPage: page('Event'),
  EventDetail: object(
    {
      ...event,
      payload: about(str, 'Тіло події, як його отримує endpoint'),
      attempts: about(
        array(attempt),
        'Спроби доставки: перша й останні 19, сторінкою за курсором',
      ),
      nextAttemptsCursor: about(
        nullable(str),
        'Курсор наступної сторінки спроб; null на останній',
      ),
    },
    [...Object.keys(event), 'payload', 'attempts'],
  ),
  Health: object({
    status: about(choice(['ok', 'error', 'shutting_down']), 'Стан процесу'),
    info: about({ type: 'object' }, 'Перевірки, що пройшли'),
    error: about({ type: 'object' }, 'Перевірки, що не пройшли'),
    details: about({ type: 'object' }, 'Усі перевірки'),
  }),
};
