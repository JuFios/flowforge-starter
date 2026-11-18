import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { Tenant } from './tenant.entity';
import { TENANT_ID_DEFAULT } from './tenant-column';
import { WorkflowVersion } from './workflow-version.entity';

export type ExecutionStatus = 'pending' | 'running' | 'succeeded' | 'failed';

@Entity('executions')
@Index(['tenantId', 'createdAt'])
// Ціль композитних FK із jobs і step_runs: задача чи крок можуть посилатися лише на виконання
// свого тенанта.
@Unique('UQ_executions_id_tenant', ['id', 'tenantId'])
// Очищення історії: завершені виконання, старші за EXECUTION_RETENTION_DAYS.
@Index('IDX_executions_finished', ['finishedAt'], {
  where: `"status" IN ('succeeded', 'failed')`,
})
// Ключ ідемпотентності запуску (заголовок Idempotency-Key): одне виконання на ключ у тенанті.
@Index('UQ_executions_idempotency_key', ['tenantId', 'idempotencyKey'], {
  unique: true,
  where: `"idempotencyKey" IS NOT NULL`,
})
// Без знімку може бути лише історичне завершене виконання (створене до появи версій, workflow
// якого вже видалено); будь-яке виконання, яке ще треба виконати, знімок мусить мати.
@Check(
  'CHK_executions_version_snapshot',
  `"workflowVersionId" IS NOT NULL OR "status" IN ('succeeded', 'failed')`,
)
export class Execution {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', default: TENANT_ID_DEFAULT })
  tenantId: string;

  @ManyToOne(() => Tenant, { onDelete: 'NO ACTION' })
  @JoinColumn({
    name: 'tenantId',
    foreignKeyConstraintName: 'FK_executions_tenant',
  })
  tenant?: Tenant;

  @Column('uuid')
  workflowId: string;

  /** Знімок кроків, зафіксований під час створення виконання; воркер виконує саме його. */
  @Column({ type: 'uuid', nullable: true })
  workflowVersionId: string | null;

  /**
   * Знімок свого ж тенанта (композитний FK). MATCH SIMPLE: історичне завершене виконання без
   * знімку (`workflowVersionId` NULL, див. CHK_executions_version_snapshot) лишається валідним.
   */
  @ManyToOne(() => WorkflowVersion, { onDelete: 'RESTRICT' })
  @JoinColumn([
    {
      name: 'workflowVersionId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'FK_executions_version_tenant',
    },
    {
      name: 'tenantId',
      referencedColumnName: 'tenantId',
      foreignKeyConstraintName: 'FK_executions_version_tenant',
    },
  ])
  workflowVersion?: WorkflowVersion;

  @Column({ type: 'varchar', default: 'pending' })
  status: ExecutionStatus;

  @Column({ type: 'jsonb', default: {} })
  input: Record<string, unknown>;

  @Column({ type: 'jsonb', nullable: true })
  output: unknown;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @Column({ type: 'varchar', default: 'api' })
  trigger: 'api' | 'webhook' | 'cron';

  /** Кореляційний ID запиту/спрацювання, що породило запис (x-request-id). */
  @Column({ type: 'varchar', length: 128, nullable: true })
  correlationId: string | null;

  /**
   * Ключ ідемпотентності запуску з заголовка `Idempotency-Key` (POST /workflows/:id/run): повтор
   * запиту з тим самим ключем повертає це виконання замість створення нового.
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  idempotencyKey: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  finishedAt: Date | null;
}
