import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type {
  OperationObject,
  ParameterObject,
  ResponseObject,
  SecurityRequirementObject,
  SchemaObject,
} from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import {
  schemas,
  uuid,
  integer,
  str,
  eventStatus,
  status,
  ref,
  limitError,
} from './schemas';

const key = [{ tenantKey: [] }];
const tenant = [...key, { browserSession: [] }];
const admin = [{ administrator: [] }];
const webhook = [{ deliverySignature: [] }];
const notes = '/tenants/me/notifications';
const keys = '/tenants/me/webhook-secrets';
const httpMethods = ['get', 'post', 'patch', 'put', 'delete'] as const;
const param = (
  name: string,
  location: 'header' | 'query',
  schema: SchemaObject,
  required = false,
): ParameterObject => ({ name, in: location, schema, required });
function page(maximum: number): ParameterObject[] {
  return [
    param('limit', 'query', {
      type: 'integer',
      minimum: 1,
      maximum,
      default: 50,
    }),
    param('cursor', 'query', {
      ...str,
      description:
        'Непрозорий курсор попередньої відповіді того самого списку з тими самими фільтрами. Курсор іншого списку чи фільтра — 400 `cursor does not match the filter`.',
    }),
  ];
}

/** Відмови `429`, які маршрут повертає, крім `rate_limited` (його має кожен маршрут з автентифікацією). */
type LimitCode =
  | 'queue_full'
  | 'outbox_full'
  | 'workflow_limit_reached'
  | 'ticket_limit'
  | 'detail_in_progress';
/** Пояснення кодів `429` в описі відповіді. */
const LIMIT_TEXT: Record<LimitCode | 'rate_limited', string> = {
  rate_limited:
    'rate_limited — перевищено ліміт частоти запитів; Retry-After каже, коли почнеться нове вікно',
  detail_in_progress:
    'detail_in_progress — тенант уже читає стільки повних деталей одночасно, скільки дозволено; Retry-After каже, коли повторити',
  queue_full:
    'queue_full — черга тенанта заповнена; місце звільнить завершення його задач',
  outbox_full:
    'outbox_full — заповнена квота недоставлених сповіщень і живих виконань; місце звільнить доставка або відмова від подій',
  workflow_limit_reached:
    'workflow_limit_reached — досягнуто ліміту кількості workflow; місце звільнить видалення процесу',
  ticket_limit:
    'ticket_limit — забагато невикористаних тикетів; місце звільнить використання або спливання тикетів',
};
/** Коди, відповідь яких несе `Retry-After`. */
const TIMED: ReadonlySet<string> = new Set([
  'rate_limited',
  'detail_in_progress',
]);

interface Contract {
  title: string;
  auth: SecurityRequirementObject[];
  result?: string;
  code?: number;
  body?: string;
  params?: ParameterObject[];
  errors?: number[];
  /** Опис відповіді 200 на ідемпотентний повтор того самого запиту (успіх — 201). */
  replay?: string;
  /** Параметр шляху не дає 404 (повтор відкликання відсутнього ключа — 204). */
  noNotFound?: true;
  /** Тимчасова відмова 503 несе `Retry-After` (спільний пул інстансу зайнятий). */
  retryUnavailable?: true;
  /** Коди `429` маршруту, крім `rate_limited`. */
  limits?: LimitCode[];
  /** Приклад тіла запиту для «Try it out»; тест надсилає його на операцію. */
  example?: Record<string, unknown>;
}

/** Групи операцій у Swagger UI, у порядку показу. */
const TAGS = [
  {
    name: 'Процеси',
    description: 'Визначення workflow: кроки, розклад і запуск',
  },
  {
    name: 'Виконання',
    description: 'Перебіг і результати виконань, повтор і тикети real-time',
  },
  {
    name: 'Вхідні webhook-и',
    description: 'Запуск процесу підписаною доставкою зовнішньої системи',
  },
  {
    name: 'Ключі webhook-ів',
    description: 'Ротація секрету підпису вхідних webhook-ів без простою',
  },
  {
    name: 'Сповіщення',
    description:
      'Підписані сповіщення про завершення виконань: налаштування, ключі й журнал доставки',
  },
  {
    name: 'Сесії браузера',
    description: 'Обмін API-ключа на відкличну сесію інтерфейсу',
  },
  {
    name: 'Тенанти',
    description: 'Адміністрування: створення тенантів і їхні ліміти',
  },
  { name: 'Службові', description: 'Перевірки стану процесу й бази даних' },
];
/** Група операції за шляхом; шлях без групи — помилка побудови документа. */
function tagOf(path: string): string {
  const groups: Array<[RegExp, string]> = [
    [/^\/(health|ready)$/, 'Службові'],
    [/^\/tenants\/me\/webhook-secrets/, 'Ключі webhook-ів'],
    [/^\/tenants\/me\/notifications/, 'Сповіщення'],
    [/^\/tenants($|\/\{id\})/, 'Тенанти'],
    [/^\/sessions/, 'Сесії браузера'],
    [/^\/workflows/, 'Процеси'],
    [/^\/executions/, 'Виконання'],
    [/^\/hooks\//, 'Вхідні webhook-и'],
  ];
  const found = groups.find(([pattern]) => pattern.test(path));
  if (!found) throw new Error('Відсутня група операції ' + path);
  return found[1];
}
const contracts: Record<string, Contract> = {
  'get /health': { title: 'Перевірити процес', auth: [], result: 'Health' },
  'get /ready': {
    title: 'Перевірити підключення до PostgreSQL',
    auth: [],
    result: 'Health',
    errors: [503],
  },
  'post /tenants': {
    title: 'Створити тенанта й одноразово отримати обидва секрети',
    auth: admin,
    result: 'TenantCredentials',
    body: 'CreateTenant',
    example: {
      name: 'acme',
      limits: { maxConcurrentExecutions: 5, rateLimit: 600 },
    },
  },
  'get /tenants/{id}/limits': {
    title: 'Прочитати чинні ліміти та перевизначення',
    auth: admin,
    result: 'Limits',
  },
  'patch /tenants/{id}/limits': {
    title: 'Змінити ліміти. null повертає значення за замовчуванням',
    auth: admin,
    result: 'Limits',
    body: 'LimitsPatch',
    example: { maxQueueSize: 50_000, rateLimit: null },
  },
  'post /sessions': {
    title: 'Обміняти ключ на відкличну браузерну сесію',
    auth: key,
    result: 'Session',
  },
  'delete /sessions/current': {
    title: 'Відкликати поточну сесію. Ліміт 60 запитів на хвилину на тенанта',
    auth: [{ browserSession: [] }],
    code: 204,
  },
  'get /workflows': {
    title: 'Переглянути сторінку визначень без кроків',
    auth: tenant,
    result: 'WorkflowPage',
    params: page(100),
  },
  'post /workflows': {
    title: 'Створити процес',
    auth: tenant,
    result: 'Workflow',
    body: 'CreateWorkflow',
    limits: ['workflow_limit_reached'],
    example: {
      name: 'order-sync',
      steps: [
        {
          id: 'fetch',
          type: 'http',
          method: 'GET',
          url: 'https://example.com/?order={{ input.order }}',
          headers: { Accept: 'application/json' },
        },
        { id: 'summary', type: 'transform', expr: '{"status": "synced"}' },
        { id: 'pause', type: 'delay', ms: 1000 },
        { id: 'note', type: 'log', message: 'order {{ input.order }} synced' },
      ],
    },
  },
  'get /workflows/{id}': {
    title: 'Прочитати визначення з маркерами збережених заголовків',
    auth: tenant,
    result: 'Workflow',
  },
  'patch /workflows/{id}': {
    title:
      'Оновити процес. Браузерні сесії та маркери keep потребують актуальної editRevision',
    auth: tenant,
    result: 'Workflow',
    body: 'UpdateWorkflow',
    errors: [409, 428],
    example: { name: 'order-sync (weekdays)', enabled: true },
  },
  'delete /workflows/{id}': {
    title: 'Видалити процес',
    auth: tenant,
    code: 204,
  },
  'post /workflows/{id}/run': {
    title: 'Запустити процес із JSON-об’єктом',
    auth: tenant,
    result: 'Execution',
    body: 'RunInput',
    params: [param('Idempotency-Key', 'header', { ...str, maxLength: 255 })],
    // 409 — ключ щойно звільнило очищення історії виконань між пошуком і вставкою.
    errors: [409, 422],
    replay: 'Ідемпотентний повтор того самого запиту',
    limits: ['queue_full', 'outbox_full'],
    example: { order: 'A-1001' },
  },
  'get /executions': {
    title: 'Переглянути сторінку виконань без вхідних і вихідних даних',
    auth: tenant,
    result: 'ExecutionPage',
    params: [
      ...page(200),
      param('status', 'query', status),
      param('workflowId', 'query', uuid),
    ],
  },
  'get /executions/{id}': {
    title: 'Прочитати повне виконання з результатами кроків',
    auth: tenant,
    result: 'ExecutionDetail',
    errors: [503],
    retryUnavailable: true,
    limits: ['detail_in_progress'],
  },
  'get /executions/{id}/summary': {
    title: 'Прочитати поточний знімок стану і план кроків',
    auth: tenant,
    result: 'ExecutionSummary',
  },
  'get /executions/{id}/steps/{index}': {
    title: 'Прочитати результат одного кроку',
    auth: tenant,
    result: 'StepDetail',
  },
  'get /executions/{id}/output': {
    title: 'Прочитати результат виконання',
    auth: tenant,
    result: 'Output',
  },
  'post /executions/{id}/retry': {
    title: 'Поновити виконання з першого незавершеного кроку',
    auth: tenant,
    result: 'ExecutionId',
    code: 202,
    errors: [409],
    limits: ['queue_full', 'outbox_full'],
    params: [
      param('expectedTerminalCycle', 'query', {
        ...integer,
        minimum: 0,
        maximum: 2_147_483_647,
        description:
          'Значення terminalCycles зі знімка failed. Передавайте той самий номер під час повтору запиту. Якщо цикл змінився або він уже не failed, API повертає 409 (retry_cycle_conflict). Без параметра повторюється поточний failed.',
      }),
    ],
  },
  'post /executions/{id}/realtime-tickets': {
    title: 'Отримати одноразовий тикет на одну підписку цього виконання',
    auth: tenant,
    result: 'Ticket',
    limits: ['ticket_limit'],
  },
  'post /hooks/{workflowId}': {
    title: 'Прийняти підписану доставку в межах п’яти хвилин',
    auth: webhook,
    result: 'WebhookAccepted',
    body: 'RunInput',
    code: 202,
    limits: ['queue_full', 'outbox_full'],
    example: { order: 'A-1001', source: 'shop' },
    params: [
      param(
        'X-Webhook-Delivery-Id',
        'header',
        { ...str, pattern: '^[A-Za-z0-9._-]{1,128}$' },
        true,
      ),
      param(
        'X-Webhook-Timestamp',
        'header',
        { ...str, description: 'Unix-час у секундах' },
        true,
      ),
    ],
    errors: [409],
  },
  ['get ' + keys]: {
    title: 'Переглянути ID ключів вхідних webhook',
    auth: key,
    result: 'SigningKeys',
  },
  ['post ' + keys]: {
    title: 'Видати наступний секрет вхідних webhook один раз',
    auth: key,
    result: 'NewKey',
    errors: [409],
  },
  ['delete ' + keys + '/{keyId}']: {
    title:
      'Відкликати ключ вхідних webhook. Повтор для відсутнього ключа — 204',
    auth: key,
    code: 204,
    errors: [409],
    noNotFound: true,
  },
  ['get ' + notes]: {
    title: 'Прочитати підписку на сповіщення',
    auth: key,
    result: 'Settings',
    errors: [404],
  },
  ['put ' + notes]: {
    title: 'Зберегти підписку. Перша відповідь містить секрет',
    auth: key,
    result: 'SettingsResult',
    body: 'SettingsInput',
    example: { url: 'https://example.com/flowforge-hooks', enabled: true },
  },
  ['delete ' + notes]: {
    title:
      'Видалити налаштування сповіщень. Недоставлені події чекають наступного налаштування',
    auth: key,
    code: 204,
    errors: [404],
  },
  ['post ' + notes + '/events/discard']: {
    title: 'Відмовитися від недоставлених подій, створених до запиту',
    auth: key,
    code: 200,
    result: 'Discarded',
  },
  ['post ' + notes + '/secrets']: {
    title: 'Видати наступний секрет підпису сповіщень один раз',
    auth: key,
    result: 'NewKey',
    errors: [404, 409],
  },
  ['delete ' + notes + '/secrets/{keyId}']: {
    title: 'Відкликати ключ підпису сповіщень',
    auth: key,
    code: 204,
    errors: [409],
  },
  ['get ' + notes + '/events']: {
    title: 'Переглянути події доставки',
    auth: key,
    result: 'EventPage',
    params: [...page(100), param('status', 'query', eventStatus)],
  },
  ['get ' + notes + '/events/{id}']: {
    title:
      'Прочитати подію. Без параметрів повертаються всі спроби, з параметрами — сторінка й nextAttemptsCursor',
    auth: key,
    result: 'EventDetail',
    params: page(100),
  },
  ['post ' + notes + '/events/{id}/redeliver']: {
    title: 'Поставити подію на доставку знову',
    auth: key,
    result: 'Event',
    code: 202,
    errors: [409],
    limits: ['outbox_full'],
  },
};
const descriptions: Record<number, string> = {
  400: 'Помилка валідації',
  401: 'Недійсні облікові дані',
  403: 'Доступ заборонено',
  404: 'Ресурс недоступний',
  409: 'Конфлікт поточного стану',
  413: 'Перевищено межу тіла',
  415: 'Непідтримуване кодування тіла',
  500: 'Внутрішня помилка; тіло без внутрішніх деталей, з correlationId',
  422: 'Ключ повторно використано з іншими даними',
  428: 'Браузерний запит має містити актуальну editRevision',
  503: 'Залежність недоступна',
};
/** Заголовки ліміту частоти (`limits/rate-limit-headers.ts`). */
const RATE_LIMIT_HEADERS: Array<[string, string]> = [
  ['Limit', 'Скільки запитів дозволено у вікні ліміту'],
  ['Remaining', 'Скільки запитів лишилось у поточному вікні'],
  ['Reset', 'Секунди до початку нового вікна'],
];
const json = (name: string) => ({ 'application/json': { schema: ref(name) } });
export function buildDocument(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle('FlowForge API')
    .setVersion('1.0')
    .setDescription(
      'HTTP-контракт FlowForge. Дані ізольовані за тенантом. Протокол WebSocket і формат підпису webhook описані в README.',
    )
    .addApiKey({ type: 'apiKey', in: 'header', name: 'X-API-Key' }, 'tenantKey')
    .addApiKey(
      { type: 'apiKey', in: 'header', name: 'X-Admin-Token' },
      'administrator',
    )
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: 'X-Signature',
        description:
          'HMAC-SHA256 над канонічним префіксом доставки та точними байтами тіла (README 3.3.7).',
      },
      'deliverySignature',
    )
    .addBearerAuth({ type: 'http', scheme: 'bearer' }, 'browserSession')
    .build();
  const doc = SwaggerModule.createDocument(app, config);
  doc.components = { ...doc.components, schemas };
  doc.tags = TAGS;
  for (const [path, item] of Object.entries(doc.paths))
    for (const method of httpMethods) {
      const op: OperationObject | undefined = item[method];
      if (!op) continue;
      const c = contracts[method + ' ' + path];
      if (!c) throw new Error('Відсутній контракт ' + method + ' ' + path);
      op.summary = c.title;
      op.tags = [tagOf(path)];
      op.security = c.auth;
      const params: ParameterObject[] = Array.from(
        path.matchAll(/\{(\w+)\}/g),
        ([, name]) => ({
          in: 'path',
          name,
          required: true,
          schema:
            name === 'index' ? { ...integer, minimum: 0, maximum: 49 } : uuid,
        }),
      );
      op.parameters = [...params, ...(c.params ?? [])];
      delete op.requestBody;
      if (c.body)
        op.requestBody = {
          required: c.body !== 'RunInput',
          content: {
            'application/json': { schema: ref(c.body), example: c.example },
          },
        };
      const success: ResponseObject = {
        description: c.title,
        ...(c.result ? { content: json(c.result) } : {}),
      };
      const headers: NonNullable<ResponseObject['headers']> = {
        'X-Request-Id': { schema: str, description: 'Ідентифікатор кореляції' },
      };
      // Заголовки ліміту частоти гарантовано несе відповідь, що пройшла ліміт; помилки розбору тіла
      // (400, 413, 415) і відмови автентифікації виникають раніше й можуть їх не мати.
      const limited: NonNullable<ResponseObject['headers']> = { ...headers };
      if (c.auth.length)
        for (const [name, description] of RATE_LIMIT_HEADERS)
          limited['X-RateLimit-' + name] = { schema: integer, description };
      success.headers = limited;
      op.responses = { [c.code ?? (method === 'post' ? 201 : 200)]: success };
      if (c.replay) op.responses[200] = { ...success, description: c.replay };
      // Парсери читають надіслане тіло до вибору маршруту незалежно від HTTP-методу.
      const errors = new Set([
        ...(c.errors ?? []),
        ...(c.auth.length ? [c.auth === admin ? 403 : 401, 429] : []),
        ...(params.length && !c.noNotFound ? [404] : []),
        400,
        413,
        415,
        500,
      ]);
      const limits = ['rate_limited' as const, ...(c.limits ?? [])];
      for (const code of errors)
        op.responses[code] = {
          description:
            code === 429
              ? limits.map((name) => LIMIT_TEXT[name]).join('. ') + '.'
              : descriptions[code],
          content:
            code === 429
              ? { 'application/json': { schema: limitError(limits) } }
              : json(
                  code === 503 && c.result === 'Health' ? 'Health' : 'Error',
                ),
          headers:
            code === 429
              ? {
                  ...headers,
                  'Retry-After': {
                    schema: integer,
                    description:
                      'Секунди до повтору для ' +
                      limits.filter((name) => TIMED.has(name)).join(' і '),
                  },
                }
              : code === 503 && c.retryUnavailable
                ? {
                    ...headers,
                    'Retry-After': {
                      schema: integer,
                      description:
                        'Секунди до повтору, поки спільний пул зайнятий',
                    },
                  }
                : headers,
        };
    }
  return doc;
}
export function installOpenApi(app: INestApplication) {
  SwaggerModule.setup('docs', app, buildDocument(app), {
    swaggerOptions: { persistAuthorization: false, validatorUrl: null },
  });
}
