import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Execution } from './execution.entity';
import { Tenant } from './tenant.entity';
import { TENANT_ID_DEFAULT } from './tenant-column';

/**
 * `failed` — неповторювана помилка; `dead` — повторювані помилки вичерпали ліміт спроб (окремий
 * стан, щоб такі задачі можна було знайти й розібрати).
 */
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'dead';

@Entity('jobs')
// Захоплення: найраніша готова задача тенанта-кандидата серед queued; облік — найраніша задача
// тенанта в черзі. Частковий індекс не містить завершених задач, яких з часом переважна більшість.
@Index('IDX_jobs_tenant_queue', ['tenantId', 'runAt'], {
  where: `"status" = 'queued'`,
})
// Reaper: задачі в роботі з простроченим lease.
@Index('IDX_jobs_lease', ['lockedUntil'], { where: `"status" = 'running'` })
// Задача виконання: повтор виконання (POST /executions/:id/retry), видалення історії.
@Index('IDX_jobs_execution', ['executionId'])
// Очищення: завершені задачі, старші за термін зберігання (FINISHED_JOBS_SQL).
@Index('IDX_jobs_finished', ['finishedAt'], {
  where: `"status" IN ('done', 'failed', 'dead')`,
})
export class Job {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', default: TENANT_ID_DEFAULT })
  tenantId: string;

  @ManyToOne(() => Tenant, { onDelete: 'NO ACTION' })
  @JoinColumn({ name: 'tenantId', foreignKeyConstraintName: 'FK_jobs_tenant' })
  tenant?: Tenant;

  @Column('uuid')
  executionId: string;

  /** Виконання свого ж тенанта (композитний FK). */
  @ManyToOne(() => Execution, { onDelete: 'NO ACTION' })
  @JoinColumn([
    {
      name: 'executionId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'FK_jobs_execution_tenant',
    },
    {
      name: 'tenantId',
      referencedColumnName: 'tenantId',
      foreignKeyConstraintName: 'FK_jobs_execution_tenant',
    },
  ])
  execution?: Execution;

  @Column({ type: 'varchar', default: 'queued' })
  status: JobStatus;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  runAt: Date;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'int', default: 3 })
  maxAttempts: number;

  @Column({ type: 'varchar', nullable: true })
  lockedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  lockedUntil: Date | null;

  /**
   * Fencing-токен поточного lease: новий на кожне захоплення. Кожен запис воркера про задачу
   * містить умову на цей токен, тож воркер, чий lease уже забрали, нічого не перезапише.
   */
  @Column({ type: 'uuid', nullable: true })
  lockToken: string | null;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  /** Кореляційний ID запиту/спрацювання, що породило запис (x-request-id). */
  @Column({ type: 'varchar', length: 128, nullable: true })
  correlationId: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  /**
   * Коли задача стала завершеною (`done`, `failed`, `dead`) — за годинником БД. За ним завершені
   * задачі видаляються після JOB_RETENTION_DAYS; виконання й кроки (історія тенанта) лишаються.
   */
  @Column({ type: 'timestamptz', nullable: true })
  finishedAt: Date | null;
}
