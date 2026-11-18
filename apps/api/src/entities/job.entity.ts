import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * `failed` — неповторювана помилка; `dead` — повторювані помилки вичерпали ліміт спроб (окремий
 * стан, щоб такі задачі можна було знайти й розібрати).
 */
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'dead';

@Entity('jobs')
// Захоплення: найраніша готова задача серед queued (часткий індекс не містить завершених задач,
// яких з часом переважна більшість).
@Index('IDX_jobs_claim', ['runAt'], { where: `"status" = 'queued'` })
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

  @Column('uuid')
  tenantId: string;

  @Column('uuid')
  executionId: string;

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
