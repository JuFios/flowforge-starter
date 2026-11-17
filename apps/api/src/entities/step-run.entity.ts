import {
  Column,
  CreateDateColumn,
  Entity,
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

  /** Скільки разів крок починали (повтори після помилки, падіння воркера). */
  @Column({ type: 'int', default: 1 })
  attempts: number;

  @Column({ type: 'jsonb', nullable: true })
  output: unknown;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  startedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  finishedAt: Date | null;
}
