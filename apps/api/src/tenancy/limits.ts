/**
 * Ліміти тенанта: значення за замовчуванням (поки db:provision не записав значень з env), межі
 * (CHECK у БД, валідація адмін-API й db:provision) і вирази CHECK перевизначень у `tenants`.
 * Контракт — README, «Контракт лімітів».
 */

/** Значення лімітів за замовчуванням до першого `db:provision` (те саме, що й у env за замовчуванням). */
export const BUILT_IN_LIMIT_DEFAULTS = {
  maxRunning: 10,
  maxQueueSize: 100_000,
  rateLimit: 600,
  rateWindowMs: 60_000,
  webhookRateLimit: 600,
  webhookRateWindowMs: 60_000,
  maxWorkflows: 1_000,
};

/** Межі лімітів (CHECK у БД, валідація адмін-API і db:provision — README, «Контракт лімітів»). */
export const LIMIT_BOUNDS = {
  maxRunning: [1, 1_000],
  maxQueueSize: [1, 10_000_000],
  rateLimit: [1, 1_000_000],
  rateWindowMs: [1_000, 3_600_000],
  // Збережені визначення тенанта: кожне до 64 КіБ, тож межа тримає обсяг тенанта в БД скінченним.
  maxWorkflows: [1, 100_000],
} as const;

const range = (column: string, [lo, hi]: readonly [number, number]) =>
  `"${column}" IS NULL OR "${column}" BETWEEN ${lo} AND ${hi}`;

/** Перевизначення лімітів тенанта: NULL або значення в межах (ті самі імена — у сутності Tenant). */
export const TENANT_LIMIT_CHECKS = {
  CHK_tenants_max_concurrent_executions: range(
    'maxConcurrentExecutions',
    LIMIT_BOUNDS.maxRunning,
  ),
  CHK_tenants_max_queue_size: range('maxQueueSize', LIMIT_BOUNDS.maxQueueSize),
  CHK_tenants_rate_limit: range('rateLimit', LIMIT_BOUNDS.rateLimit),
  CHK_tenants_webhook_rate_limit: range(
    'webhookRateLimit',
    LIMIT_BOUNDS.rateLimit,
  ),
};

/**
 * CHECK перевизначення квоти workflow. Окремо від TENANT_LIMIT_CHECKS: ту мапу обходить історична
 * міграція TenantUsage, коли колонки ще немає.
 */
export const WORKFLOW_QUOTA_CHECK = {
  name: 'CHK_tenants_max_workflows',
  expression: range('maxWorkflows', LIMIT_BOUNDS.maxWorkflows),
};

/** Перевизначення лімітів у тенанта (NULL — значення за замовчуванням). */
export interface TenantLimitOverrides {
  maxConcurrentExecutions: number | null;
  maxQueueSize: number | null;
  rateLimit: number | null;
  webhookRateLimit: number | null;
  maxWorkflows: number | null;
}

/** Межі кожного перевизначення (ті самі, що в CHECK). */
export const OVERRIDE_BOUNDS: Record<
  keyof TenantLimitOverrides,
  readonly [number, number]
> = {
  maxConcurrentExecutions: LIMIT_BOUNDS.maxRunning,
  maxQueueSize: LIMIT_BOUNDS.maxQueueSize,
  rateLimit: LIMIT_BOUNDS.rateLimit,
  webhookRateLimit: LIMIT_BOUNDS.rateLimit,
  maxWorkflows: LIMIT_BOUNDS.maxWorkflows,
};

/** Ефективні ліміти тенанта (`tenant_limits()`): перевизначення або значення за замовчуванням. */
export interface EffectiveLimits {
  maxRunning: number;
  maxQueueSize: number;
  rateLimit: number;
  rateWindowMs: number;
  webhookRateLimit: number;
  webhookRateWindowMs: number;
  maxWorkflows: number;
}

/** Найдовший ключ відра частоти запитів (`<throttler>:<tenantId або IP>`). */
export const RATE_KEY_MAX_LENGTH = 200;

/** SQLSTATE відмови тригера квоти workflow (міграція WorkflowQuota) → 429 `workflow_limit_reached`. */
export const WORKFLOW_QUOTA_SQLSTATE = 'FF001';
