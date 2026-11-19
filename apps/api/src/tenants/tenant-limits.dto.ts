import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { OVERRIDE_BOUNDS } from '../tenancy/limits';

const [RUNNING_MIN, RUNNING_MAX] = OVERRIDE_BOUNDS.maxConcurrentExecutions;
const [QUEUE_MIN, QUEUE_MAX] = OVERRIDE_BOUNDS.maxQueueSize;
const [RATE_MIN, RATE_MAX] = OVERRIDE_BOUNDS.rateLimit;
const [WEBHOOK_MIN, WEBHOOK_MAX] = OVERRIDE_BOUNDS.webhookRateLimit;

/**
 * Перевизначення лімітів тенанта (README, «Контракт лімітів»). Поле відсутнє — без змін, `null` —
 * значення за замовчуванням (`TENANT_*` у db:provision), число — у межах контракту.
 */
export class TenantLimitsDto {
  /** Задач у роботі одночасно (діє на нові захоплення). */
  @IsOptional()
  @IsInt()
  @Min(RUNNING_MIN)
  @Max(RUNNING_MAX)
  maxConcurrentExecutions?: number | null;

  /** Незавершених задач у черзі, включно з паузами (діє на нові постановки). */
  @IsOptional()
  @IsInt()
  @Min(QUEUE_MIN)
  @Max(QUEUE_MAX)
  maxQueueSize?: number | null;

  /** Запитів до API за вікно TENANT_RATE_WINDOW_MS. */
  @IsOptional()
  @IsInt()
  @Min(RATE_MIN)
  @Max(RATE_MAX)
  rateLimit?: number | null;

  /** Webhook-ів за вікно TENANT_WEBHOOK_RATE_WINDOW_MS (окрема квота від API). */
  @IsOptional()
  @IsInt()
  @Min(WEBHOOK_MIN)
  @Max(WEBHOOK_MAX)
  webhookRateLimit?: number | null;
}

export const LIMIT_FIELDS = [
  'maxConcurrentExecutions',
  'maxQueueSize',
  'rateLimit',
  'webhookRateLimit',
] as const;
