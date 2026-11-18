import {
  Column,
  CreateDateColumn,
  Entity,
  Generated,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type StepRunStatus = 'running' | 'succeeded' | 'failed';

/**
 * Чекпоінт кроку виконання: рівно один рядок на крок (`executionId`, `stepIndex`). Повтор задачі
 * продовжує з першого кроку, що не має `succeeded`; результат завершеного кроку береться звідси,
 * а не обчислюється знову.
 */
@Entity('step_runs')
@Index('UQ_step_runs_execution_step', ['executionId', 'stepIndex'], {
  unique: true,
})
// Пошук кроку за ключем ідемпотентності (напр., коли отримувач питає про запит за ключем).
@Index('UQ_step_runs_idempotency_key', ['idempotencyKey'], { unique: true })
export class StepRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  executionId: string;

  @Column('int')
  stepIndex: number;

  @Column()
  stepId: string;

  @Column({ type: 'varchar', default: 'running' })
  status: StepRunStatus;

  /**
   * Ключ ідемпотентності кроку: створюється разом із рядком при першій спробі й однаковий для
   * всіх наступних (повтор після помилки, після падіння воркера). Крок `http` передає його
   * отримувачу в заголовку `Idempotency-Key`.
   */
  @Column('uuid')
  @Generated('uuid')
  idempotencyKey: string;

  /** Скільки разів крок починали (повтори після помилки, падіння воркера). */
  @Column({ type: 'int', default: 1 })
  attempts: number;

  @Column({ type: 'jsonb', nullable: true })
  output: unknown;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  /**
   * Лише для `delay`: момент пробудження, зафіксований за годинником БД на початку паузи.
   * Поки він не настав, задача стоїть у черзі з `runAt = wakeAt` і слота воркера не займає.
   */
  @Column({ type: 'timestamptz', nullable: true })
  wakeAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  startedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  finishedAt: Date | null;
}
