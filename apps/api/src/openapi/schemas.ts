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
import {
  API_KEY_PATTERN,
  SIGNING_SECRET_PATTERN,
} from '../common/key-material';

export const str: SchemaObject = { type: 'string' };
export const integer: SchemaObject = { type: 'integer' };
const bool: SchemaObject = { type: 'boolean' };
export const uuid: SchemaObject = { type: 'string', format: 'uuid' };
const date: SchemaObject = { type: 'string', format: 'date-time' };
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
const marker = (key: string) =>
  closed({ [key]: { type: 'boolean', enum: [true] } });
const text = (maxLength: number): SchemaObject => ({
  type: 'string',
  maxLength,
});
export const status = choice(['pending', 'running', 'succeeded', 'failed']);
export const eventStatus = choice(EVENT_STATUSES);
const types = ['http', 'log', 'transform', 'delay'];
const stepId = { ...str, pattern: '^[a-z][a-z0-9_]{0,31}$' };
const rawHeader = text(MAX_HEADER_VALUE_LENGTH);
function steps(mode: 'create' | 'update' | 'read'): SchemaObject {
  const value =
    mode === 'read'
      ? marker('stored')
      : mode === 'update'
        ? { oneOf: [rawHeader, marker('keep')] }
        : rawHeader;
  const step = (
    type: string,
    props: Record<string, SchemaObject>,
    required: string[],
  ) =>
    closed({ id: stepId, type: choice([type]), ...props }, [
      'id',
      'type',
      ...required,
    ]);
  return {
    type: 'array',
    minItems: 1,
    maxItems: MAX_STEPS,
    items: {
      oneOf: [
        step(
          'http',
          {
            url: text(MAX_URL_LENGTH),
            method: choice(HTTP_METHODS),
            headers: {
              type: 'object',
              maxProperties: MAX_HEADERS,
              additionalProperties: value,
            },
            body: str,
          },
          ['url'],
        ),
        step('log', { message: text(MAX_LOG_MESSAGE_LENGTH) }, ['message']),
        step(
          'transform',
          {
            expr: text(MAX_EXPRESSION_LENGTH),
            language: choice(['jsonata-v1']),
          },
          ['expr'],
        ),
        step(
          'delay',
          { ms: { type: 'integer', minimum: 0, maximum: MAX_DELAY_MS } },
          ['ms'],
        ),
      ],
    },
  };
}
const definition = {
  name: { ...text(200), minLength: 1 },
  enabled: bool,
  cron: nullable(text(100)),
  timezone: text(64),
  missedRunPolicy: choice(['skip', 'run_once', 'run_all']),
};
const workflow = {
  id: uuid,
  ...definition,
  version: integer,
  nextFireAt: nullable(date),
  scheduleBlockedSince: nullable(date),
  scheduleError: nullable(str),
  createdAt: date,
};
const editRevision = {
  ...str,
  pattern: '^[1-9][0-9]{0,18}$',
  description:
    'Ревізія редагованої конфігурації, незалежна від версії кроків і стану планувальника',
};
const run = {
  id: uuid,
  workflowId: uuid,
  status,
  trigger: choice(['api', 'cron', 'webhook']),
  createdAt: date,
  finishedAt: nullable(date),
  scheduledAt: nullable(date),
  correlationId: nullable(str),
  error: nullable(str),
};
const listing = {
  ...run,
  workflowName: nullable(str),
  workflowVersion: nullable(integer),
};
const execution = {
  ...run,
  tenantId: uuid,
  workflowVersionId: nullable(uuid),
  input: { type: 'object', additionalProperties: true },
  output: {},
  idempotencyKey: nullable(str),
};
const step = {
  stepIndex: integer,
  stepId,
  status: choice(['running', 'succeeded', 'failed']),
  attempts: integer,
  error: nullable(str),
  startedAt: date,
  finishedAt: nullable(date),
  wakeAt: nullable(date),
};
const stepSummary = { ...step, outputBytes: nullable(integer) };
const bounds = ([minimum, maximum]: readonly number[]): SchemaObject => ({
  type: 'integer',
  minimum,
  maximum,
});
const overrides = Object.fromEntries(
  Object.entries(OVERRIDE_BOUNDS).map(([name, range]) => [
    name,
    nullable(bounds(range)),
  ]),
);
const limits = object({
  overrides: object(overrides),
  effective: object({
    ...Object.fromEntries(
      Object.entries(LIMIT_BOUNDS).map(([key, range]) => [key, bounds(range)]),
    ),
    webhookRateLimit: bounds(LIMIT_BOUNDS.rateLimit),
    webhookRateWindowMs: bounds(LIMIT_BOUNDS.rateWindowMs),
  }),
});
/** Облікові дані, які генерує клієнт (ТЗ 4: у відповідях їх немає). */
const apiKeyInput: SchemaObject = {
  type: 'string',
  pattern: API_KEY_PATTERN.source,
  description:
    'API-ключ, згенерований оператором (наприклад, `openssl rand -hex 32`). Зберігається лише його хеш.',
  writeOnly: true,
};
const signingSecret: SchemaObject = {
  type: 'string',
  pattern: SIGNING_SECRET_PATTERN.source,
  description:
    'Секрет підпису HMAC, згенерований клієнтом (наприклад, `openssl rand -hex 32`). Сервер його не повертає.',
  writeOnly: true,
};
const keyView = object({ id: uuid, role: choice(['current', 'next']) });
const settings = {
  url: str,
  enabled: bool,
  revision: integer,
  keys: array(keyView),
};
const event = {
  id: uuid,
  executionId: uuid,
  sequence: integer,
  type: str,
  status: eventStatus,
  attempts: integer,
  nextAttemptAt: nullable(date),
  lastError: nullable(str),
  lastStatus: nullable(integer),
  correlationId: nullable(str),
  createdAt: date,
  deliveredAt: nullable(date),
};
const attempt = object({
  attempt: integer,
  senderId: str,
  revision: integer,
  keyIds: array(uuid),
  startedAt: date,
  finishedAt: nullable(date),
  outcome: nullable(str),
  httpStatus: nullable(integer),
  durationMs: nullable(integer),
});
const page = (name: string) =>
  object({ items: array(ref(name)), nextCursor: nullable(str) });
export const schemas: Record<string, SchemaObject> = {
  Error: object(
    {
      statusCode: integer,
      error: str,
      message: { oneOf: [str, array(str)] },
      correlationId: str,
    },
    ['statusCode', 'message'],
  ),
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
    tenantId: uuid,
    scheduleCursor: date,
    steps: steps('read'),
  }),
  WorkflowSummary: object(workflow),
  WorkflowPage: page('WorkflowSummary'),
  Execution: object(execution),
  ExecutionListItem: object(listing),
  ExecutionPage: page('ExecutionListItem'),
  ExecutionSummary: object({
    ...listing,
    revision: { ...str, pattern: '^[0-9]+$' },
    plan: array(object({ id: stepId, type: choice(types) })),
    steps: array(object(stepSummary)),
    inputBytes: integer,
    outputBytes: nullable(integer),
  }),
  ExecutionDetail: object({
    ...execution,
    steps: array(
      object({
        ...step,
        id: uuid,
        executionId: uuid,
        tenantId: uuid,
        idempotencyKey: str,
        output: {},
      }),
    ),
  }),
  StepDetail: object({ ...stepSummary, output: {} }),
  Output: object({ output: {} }),
  ExecutionId: object({ executionId: uuid }),
  RunInput: {
    type: 'object',
    additionalProperties: true,
    example: { order: 'demo' },
  },
  Limits: limits,
  LimitsPatch: closed(overrides, []),
  CreateTenant: closed(
    {
      name: { ...text(200), minLength: 2 },
      apiKey: apiKeyInput,
      webhookSecret: signingSecret,
      limits: ref('LimitsPatch'),
    },
    ['name', 'apiKey', 'webhookSecret'],
  ),
  Tenant: object({ id: uuid, name: str, webhookKeyId: uuid, limits }),
  Session: object({ token: str, expiresAt: date }),
  Ticket: object({ ticket: str, expiresAt: date }),
  SigningKeys: array(keyView),
  NewKey: object({ id: uuid, role: choice(['next']) }),
  NewSecret: closed({ secret: signingSecret }),
  Discarded: object({ discarded: integer }),
  Settings: object(settings),
  SettingsInput: closed(
    { url: text(MAX_URL_LENGTH), enabled: bool, secret: signingSecret },
    ['url'],
  ),
  Event: object(event),
  EventPage: page('Event'),
  EventDetail: object(
    {
      ...event,
      payload: str,
      attempts: array(attempt),
      nextAttemptsCursor: nullable(str),
    },
    [...Object.keys(event), 'payload', 'attempts'],
  ),
  Health: object({
    status: choice(['ok', 'error', 'shutting_down']),
    info: { type: 'object' },
    error: { type: 'object' },
    details: { type: 'object' },
  }),
};
