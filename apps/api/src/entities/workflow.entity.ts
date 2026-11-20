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

export type StepDefinition =
  | {
      id: string;
      type: 'http';
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    }
  | { id: string; type: 'transform'; expr: string; language?: 'jsonata-v1' }
  | { id: string; type: 'log'; message: string }
  | { id: string; type: 'delay'; ms: number };

export const MISSED_RUN_POLICIES = ['skip', 'run_once', 'run_all'] as const;
export type MissedRunPolicy = (typeof MISSED_RUN_POLICIES)[number];

@Entity('workflows')
@Unique('UQ_workflows_id_tenant', ['id', 'tenantId'])
@Index(['tenantId'])
@Index('IDX_workflows_scheduled_tenant', { synchronize: false })
@Index('IDX_workflows_tenant_created', { synchronize: false })
@Index('IDX_workflows_due', { synchronize: false })
@Check(
  'CHK_workflows_missed_run_policy',
  `"missedRunPolicy" IN ('skip', 'run_once', 'run_all')`,
)
export class Workflow {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', default: TENANT_ID_DEFAULT })
  tenantId: string;

  @ManyToOne(() => Tenant, { onDelete: 'NO ACTION' })
  @JoinColumn({
    name: 'tenantId',
    foreignKeyConstraintName: 'FK_workflows_tenant',
  })
  tenant?: Tenant;

  @Column()
  name: string;

  @Column('jsonb')
  steps: StepDefinition[];

  @Column({ default: true })
  enabled: boolean;

  /** 5- або 6-польний cron; null — без розкладу. */
  @Column({ type: 'varchar', nullable: true })
  cron: string | null;

  @Column({ default: 'UTC' })
  timezone: string;

  @Column({ default: 1 })
  version: number;

  /** Ревізія редагованих полів. Стан планувальника її не змінює. */
  @Column({ type: 'bigint', default: '1' })
  editRevision: string;

  /**
   * Політика моментів розкладу, пропущених довше за SCHEDULER_MISFIRE_GRACE_MS (простій, БД
   * недоступна, повна черга): пропустити, виконати один раз чи виконати всі (README 3.3.8).
   */
  @Column({ type: 'varchar', default: 'run_once' })
  missedRunPolicy: MissedRunPolicy;

  /**
   * Прогрес планувальника: усі моменти розкладу до цього моменту включно оброблено. Переживає
   * рестарт; зміна cron, таймзони чи ввімкнення переносять його на момент зміни.
   */
  @Column({ type: 'timestamptz', default: () => 'now()' })
  scheduleCursor: Date;

  /** Не пізніше за наступний момент розкладу (підказка вибору належних розкладів). */
  @Column({ type: 'timestamptz', nullable: true })
  nextFireAt: Date | null;

  /** З якого моменту спрацювання стоїть через повну чергу тенанта; NULL — не стоїть. */
  @Column({ type: 'timestamptz', nullable: true })
  scheduleBlockedSince: Date | null;

  /** Чому розклад не обчислюється (успадкований невалідний вираз); NULL — обчислюється. */
  @Column({ type: 'text', nullable: true })
  scheduleError: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
