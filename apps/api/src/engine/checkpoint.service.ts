import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Job, StepRun } from '../entities';
import { JobQueueService } from './job-queue.service';

/**
 * Записи про перебіг кроків. Кожен метод — одна транзакція, що спершу перевіряє lease задачі
 * (`assertLease` блокує рядок job): воркер, чий lease уже забрали, нічого не запише, а стан
 * кількох таблиць змінюється разом або ніяк.
 */
@Injectable()
export class CheckpointService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly queue: JobQueueService,
  ) {}

  /** Чекпоінти виконання за порядком кроків. */
  async load(executionId: string): Promise<StepRun[]> {
    return this.ds
      .getRepository(StepRun)
      .find({ where: { executionId }, order: { stepIndex: 'ASC' } });
  }

  /**
   * Позначає початок спроби кроку: рядок кроку створюється при першій спробі, далі лише
   * збільшується `attempts`. Виконання переходить у `running`.
   */
  async startStep(
    job: Job,
    stepIndex: number,
    stepId: string,
  ): Promise<StepRun> {
    return this.ds.transaction(async (em) => {
      await this.queue.assertLease(em, job);
      const [run]: StepRun[] = await em.query(
        `INSERT INTO step_runs ("executionId", "stepIndex", "stepId", status, attempts)
         VALUES ($1, $2, $3, 'running', 1)
         ON CONFLICT ("executionId", "stepIndex") DO UPDATE
            SET status = 'running', attempts = step_runs.attempts + 1, error = NULL,
                "finishedAt" = NULL
         RETURNING *`,
        [job.executionId, stepIndex, stepId],
      );
      await em.query(
        `UPDATE executions SET status = 'running' WHERE id = $1 AND status = 'pending'`,
        [job.executionId],
      );
      return run;
    });
  }

  /**
   * Чекпоінт: результат кроку зафіксовано, і він більше не обчислюватиметься. Лічильник спроб
   * задачі починається знову з поточного захоплення (1): ліміт спроб діє на кожен крок окремо,
   * а не на весь workflow.
   */
  async checkpoint(job: Job, run: StepRun, output: unknown): Promise<void> {
    await this.ds.transaction(async (em) => {
      await this.queue.assertLease(em, job);
      await em.query(
        `UPDATE step_runs SET status = 'succeeded', output = $2, error = NULL, "finishedAt" = now()
          WHERE id = $1`,
        [run.id, JSON.stringify(output ?? null)],
      );
      await em.query(`UPDATE jobs SET attempts = 1 WHERE id = $1`, [job.id]);
    });
    job.attempts = 1;
  }

  async stepFailed(job: Job, run: StepRun, error: string): Promise<void> {
    await this.ds.transaction(async (em) => {
      await this.queue.assertLease(em, job);
      await em.query(
        `UPDATE step_runs SET status = 'failed', error = $2, "finishedAt" = now() WHERE id = $1`,
        [run.id, error],
      );
    });
  }
}
