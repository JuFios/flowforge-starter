import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Generated,
  PrimaryGeneratedColumn,
} from 'typeorm';
import {
  OUTBOX_QUOTA_CHECK,
  TENANT_LIMIT_CHECKS,
  WORKFLOW_QUOTA_CHECK,
} from '../tenancy/limits';

@Entity('tenants')
@Check(
  'CHK_webhook_key_pair',
  '("nextWebhookKeyId" IS NULL) = ("nextWebhookSecret" IS NULL) AND "webhookKeyId" IS DISTINCT FROM "nextWebhookKeyId"',
)
@Check(
  'CHK_tenants_max_concurrent_executions',
  TENANT_LIMIT_CHECKS.CHK_tenants_max_concurrent_executions,
)
@Check(
  'CHK_tenants_max_queue_size',
  TENANT_LIMIT_CHECKS.CHK_tenants_max_queue_size,
)
@Check('CHK_tenants_rate_limit', TENANT_LIMIT_CHECKS.CHK_tenants_rate_limit)
@Check(
  'CHK_tenants_webhook_rate_limit',
  TENANT_LIMIT_CHECKS.CHK_tenants_webhook_rate_limit,
)
@Check(WORKFLOW_QUOTA_CHECK.name, WORKFLOW_QUOTA_CHECK.expression)
@Check(OUTBOX_QUOTA_CHECK.name, OUTBOX_QUOTA_CHECK.expression)
export class Tenant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  /** sha256(apiKey) у hex. Сам ключ показується лише при створенні. */
  @Column({ unique: true })
  apiKeyHash: string;

  /** Секрет для підпису вхідних webhook-ів цього тенанта. */
  @Column()
  webhookSecret: string;

  @Generated('uuid')
  @Column({ type: 'uuid', select: false })
  webhookKeyId: string;

  @Column({ type: 'uuid', nullable: true, select: false })
  nextWebhookKeyId: string | null;

  @Column({ type: 'varchar', nullable: true, select: false })
  nextWebhookSecret: string | null;

  /**
   * Перевизначення лімітів тенанта (NULL — значення за замовчуванням з `limit_defaults`): задачі в
   * роботі, розмір черги (незавершені задачі), запити до API й webhook-и за вікно.
   */
  @Column({ type: 'int', nullable: true })
  maxConcurrentExecutions: number | null;

  @Column({ type: 'int', nullable: true })
  maxQueueSize: number | null;

  @Column({ type: 'int', nullable: true })
  rateLimit: number | null;

  @Column({ type: 'int', nullable: true })
  webhookRateLimit: number | null;

  /** Квота збережених workflow (NULL — `limit_defaults.maxWorkflows`). */
  @Column({ type: 'int', nullable: true })
  maxWorkflows: number | null;

  /** Квота outbox: недоставлені події + живі виконання (NULL — `limit_defaults.maxOutboxEvents`). */
  @Column({ type: 'int', nullable: true })
  maxOutboxEvents: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
