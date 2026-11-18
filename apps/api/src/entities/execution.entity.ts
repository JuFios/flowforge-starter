import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { WorkflowVersion } from './workflow-version.entity';

export type ExecutionStatus = 'pending' | 'running' | 'succeeded' | 'failed';

@Entity('executions')
@Index(['tenantId', 'createdAt'])
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

  @Column('uuid')
  tenantId: string;

  @Column('uuid')
  workflowId: string;

  /** Знімок кроків, зафіксований під час створення виконання; воркер виконує саме його. */
  @Column({ type: 'uuid', nullable: true })
  workflowVersionId: string | null;

  @ManyToOne(() => WorkflowVersion, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'workflowVersionId' })
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
