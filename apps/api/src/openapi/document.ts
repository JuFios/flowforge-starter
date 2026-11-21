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
        'Непрозорий курсор попередньої відповіді з тими самими фільтрами.',
    }),
  ];
}

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
    title:
      'Створити тенанта з API-ключем і секретом webhook, які згенерував оператор',
    auth: admin,
    result: 'Tenant',
    body: 'CreateTenant',
    errors: [409],
    replay: 'Повтор того самого запиту: чинний тенант',
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
    errors: [422],
    replay: 'Ідемпотентний повтор того самого запиту',
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
  },
  'post /executions/{id}/realtime-tickets': {
    title: 'Отримати одноразовий тикет на одну підписку цього виконання',
    auth: tenant,
    result: 'Ticket',
  },
  'post /hooks/{workflowId}': {
    title: 'Прийняти підписану доставку в межах п’яти хвилин',
    auth: webhook,
    result: 'ExecutionId',
    body: 'RunInput',
    code: 202,
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
    errors: [409, 422],
  },
  ['get ' + keys]: {
    title: 'Переглянути ID ключів вхідних webhook',
    auth: key,
    result: 'SigningKeys',
  },
  ['post ' + keys]: {
    title: 'Додати наступний ключ вхідних webhook із секретом клієнта',
    auth: key,
    result: 'NewKey',
    body: 'NewSecret',
    errors: [409],
    replay: 'Повтор із тим самим секретом: той самий ключ',
  },
  ['delete ' + keys + '/{keyId}']: {
    title: 'Відкликати ключ вхідних webhook',
    auth: key,
    code: 204,
    errors: [409],
  },
  ['get ' + notes]: {
    title: 'Прочитати підписку на сповіщення',
    auth: key,
    result: 'Settings',
    errors: [404],
  },
  ['put ' + notes]: {
    title:
      'Зберегти підписку. Перше налаштування приймає секрет підпису клієнта',
    auth: key,
    result: 'Settings',
    body: 'SettingsInput',
    errors: [409],
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
    title: 'Додати наступний ключ підпису сповіщень із секретом клієнта',
    auth: key,
    result: 'NewKey',
    body: 'NewSecret',
    errors: [404, 409],
    replay: 'Повтор із тим самим секретом: той самий ключ',
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
  422: 'Ключ повторно використано з іншими даними',
  428: 'Браузерний запит має містити актуальну editRevision',
  429: 'rate_limited повертає Retry-After. queue_full, outbox_full та workflow_limit_reached не мають визначеного часу повтору.',
  503: 'Залежність недоступна',
};
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
  for (const [path, item] of Object.entries(doc.paths))
    for (const method of httpMethods) {
      const op: OperationObject | undefined = item[method];
      if (!op) continue;
      const c = contracts[method + ' ' + path];
      if (!c) throw new Error('Відсутній контракт ' + method + ' ' + path);
      op.summary = c.title;
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
          content: json(c.body),
        };
      const success: ResponseObject = {
        description: c.title,
        ...(c.result ? { content: json(c.result) } : {}),
      };
      const headers: NonNullable<ResponseObject['headers']> = {
        'X-Request-Id': { schema: str, description: 'Ідентифікатор кореляції' },
      };
      if (c.auth.length)
        for (const name of ['Limit', 'Remaining', 'Reset'])
          headers['X-RateLimit-' + name] = {
            schema: integer,
            description: 'Вікно частоти запитів',
          };
      success.headers = headers;
      op.responses = { [c.code ?? (method === 'post' ? 201 : 200)]: success };
      if (c.replay) op.responses[200] = { ...success, description: c.replay };
      const errors = new Set([
        ...(c.errors ?? []),
        ...(c.auth.length ? [c.auth === admin ? 403 : 401, 429] : []),
        ...(params.length ? [404] : []),
        ...(params.length || c.body || c.params ? [400] : []),
        ...(c.body ? [413, 415] : []),
      ]);
      for (const code of errors)
        op.responses[code] = {
          description: descriptions[code],
          content: json(code === 503 ? 'Health' : 'Error'),
          headers:
            code === 429
              ? {
                  ...headers,
                  'Retry-After': {
                    schema: integer,
                    description: 'Секунди до закінчення вікна rate_limited',
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
