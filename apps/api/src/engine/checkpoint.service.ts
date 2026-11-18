import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { toStorable, toStorableText } from '../common/storable-text';
import { Job, StepRun } from '../entities';
import { FailureOutcome, JobQueueService } from './job-queue.service';

/**
 * Записи про перебіг кроків. Кожен метод — одна транзакція, що спершу перевіряє lease задачі
 * (`assertLease` блокує рядок job): воркер, чий lease уже забрали, нічого не запише, а стан
 * кількох таблиць змінюється разом або ніяк.
 */
@Injectable()
export class CheckpointService {
  private readonly logger = new Logger(CheckpointService.name);

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
  async checkpoint(job: Job, run: StepRun, output: unknown): Promise<unknown> {
    const stored = this.storable(job, run.stepId, output);
    await this.ds.transaction(async (em) => {
      await this.queue.assertLease(em, job);
      await em.query(
        `UPDATE step_runs SET status = 'succeeded', output = $2, error = NULL, "finishedAt" = now()
          WHERE id = $1`,
        [run.id, JSON.stringify(stored)],
      );
      await em.query(`UPDATE jobs SET attempts = 1 WHERE id = $1`, [job.id]);
    });
    job.attempts = 1;
    return stored;
  }

  /**
   * Результат кроку в тому вигляді, в якому його збереже Postgres. U+0000 і одиночні сурогати
   * (напр., у відповіді отримувача) `jsonb` не приймає: замість провалу чекпоінта (і повтору вже
   * виконаного http-запиту) вони замінюються на U+FFFD. Наступні кроки отримують саме збережене
   * значення — те саме, що й після відновлення з чекпоінта.
   */
  private storable(job: Job, stepId: string, output: unknown): unknown {
    const { value, replaced } = toStorable(output);
    if (replaced > 0)
      this.logger.warn(
        { jobId: job.id, executionId: job.executionId, stepId, replaced },
        'step result had characters Postgres cannot store, replaced with U+FFFD',
      );
    return value;
  }

  /** Виконання успішне: виконання й задача завершуються разом або ніяк. */
  async finish(job: Job, output: unknown): Promise<void> {
    await this.ds.transaction(async (em) => {
      await this.queue.completeIn(em, job);
      await em.query(
        `UPDATE executions SET status = 'succeeded', output = $2, error = NULL, "finishedAt" = now()
          WHERE id = $1`,
        [job.executionId, JSON.stringify(toStorable(output).value)],
      );
    });
  }

  /**
   * Спроба провалилась: стан кроку, задачі (повтор із backoff або кінець) і, якщо повторів не
   * буде, виконання — в одній транзакції.
   */
  async fail(
    job: Job,
    run: StepRun | undefined,
    error: string,
    retryable: boolean,
  ): Promise<FailureOutcome> {
    // Текст помилки кроку може містити дані тенанта чи отримувача (напр., U+0000).
    error = toStorableText(error);
    return this.ds.transaction(async (em) => {
      const outcome = await this.queue.failIn(em, job, error, retryable);
      if (run) {
        await em.query(
          `UPDATE step_runs SET status = 'failed', error = $2, "finishedAt" = now() WHERE id = $1`,
          [run.id, error],
        );
      }
      if (outcome !== 'retry') {
        const final =
          outcome === 'dead'
            ? `${error}; no attempts left (${job.attempts}/${job.maxAttempts})`
            : error;
        await em.query(
          `UPDATE executions SET status = 'failed', error = $2, "finishedAt" = now() WHERE id = $1`,
          [job.executionId, final],
        );
      }
      return outcome;
    });
  }

  /**
   * Довговічний таймер: фіксує момент пробудження кроку `delay` і повертає задачу в чергу з
   * `runAt` = цей момент, звільняючи lease. Слот воркера вільний; пробудження переживає будь-який
   * перезапуск, бо час зберігається в БД. Пауза — не спроба: лічильник спроб обнуляється.
   */
  async park(job: Job, run: StepRun, ms: number): Promise<Date> {
    return this.ds.transaction(async (em) => {
      await this.queue.assertLease(em, job);
      const [rows]: [Array<{ wakeAt: Date }>, number] = await em.query(
        `UPDATE step_runs SET "wakeAt" = now() + make_interval(secs => $2)
          WHERE id = $1 RETURNING "wakeAt"`,
        [run.id, ms / 1000],
      );
      const { wakeAt } = rows[0];
      await this.release(em, job, wakeAt);
      return wakeAt;
    });
  }

  /**
   * Задачу кроку `delay` знову захоплено. Якщо момент пробудження настав — крок завершено
   * (чекпоінт), інакше (напр., задачу повернув reaper раніше строку) — паркуємо знову до того
   * самого моменту. true — крок завершено і можна йти далі.
   */
  async wakeIfDue(job: Job, run: StepRun, output: unknown): Promise<boolean> {
    const due = await this.ds.transaction(async (em) => {
      await this.queue.assertLease(em, job);
      const [{ due }]: Array<{ due: boolean }> = await em.query(
        `SELECT "wakeAt" <= now() AS due FROM step_runs WHERE id = $1`,
        [run.id],
      );
      if (!due) {
        await this.release(em, job, run.wakeAt!);
        return false;
      }
      await em.query(
        `UPDATE step_runs SET status = 'succeeded', output = $2, error = NULL, "finishedAt" = now()
          WHERE id = $1`,
        [run.id, JSON.stringify(output ?? null)],
      );
      await em.query(`UPDATE jobs SET attempts = 1 WHERE id = $1`, [job.id]);
      return true;
    });
    if (due) job.attempts = 1;
    return due;
  }

  /** Повертає задачу в чергу до `runAt` без lease і без зарахованої спроби. */
  private async release(
    em: EntityManager,
    job: Job,
    runAt: Date,
  ): Promise<void> {
    await em.query(
      `UPDATE jobs
          SET status = 'queued', "runAt" = $2, attempts = 0,
              "lockedBy" = NULL, "lockedUntil" = NULL, "lockToken" = NULL
        WHERE id = $1`,
      [job.id, runAt],
    );
  }
}
