import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { toStorable, toStorableText } from '../common/storable-text';
import { Job, StepRun } from '../entities';
import { TenantDb } from '../tenancy/tenant-db';
import { FailureOutcome, JobQueueService } from './job-queue.service';

interface SavedCheckpoint {
  output: unknown;
  finishedAt: Date;
}

/**
 * Записи про перебіг кроків. Кожен метод — одна транзакція, що спершу перевіряє lease задачі
 * (`assertLease` блокує рядок job): воркер, чий lease уже забрали, нічого не запише, а стан
 * кількох таблиць змінюється разом або ніяк.
 */
@Injectable()
export class CheckpointService {
  private readonly logger = new Logger(CheckpointService.name);

  constructor(
    private readonly db: TenantDb,
    private readonly queue: JobQueueService,
  ) {}

  /** Чекпоінти виконання задачі за порядком кроків (у контексті тенанта задачі). */
  load(em: EntityManager, job: Job): Promise<StepRun[]> {
    return em.find(StepRun, {
      where: { executionId: job.executionId, tenantId: job.tenantId },
      order: { stepIndex: 'ASC' },
    });
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
    const run = await this.db.run(job.tenantId, async (em) => {
      const locked = await this.queue.assertLease(em, job);
      if (locked.attempts === 0)
        await em.query(
          'UPDATE jobs SET attempts = 1 WHERE id = $1 AND "tenantId" = $2',
          [job.id, job.tenantId],
        );
      const [run]: StepRun[] = await em.query(
        `INSERT INTO step_runs ("executionId", "tenantId", "stepIndex", "stepId", status, attempts)
         VALUES ($1, $4, $2, $3, 'running', 1)
         ON CONFLICT ("executionId", "stepIndex") DO UPDATE
            SET status = 'running', attempts = step_runs.attempts + 1, error = NULL,
                "finishedAt" = NULL
         RETURNING *`,
        [job.executionId, stepIndex, stepId, job.tenantId],
      );
      await em.query(
        `UPDATE executions SET status = 'running'
          WHERE id = $1 AND "tenantId" = $2 AND status = 'pending'`,
        [job.executionId, job.tenantId],
      );
      return run;
    });
    job.attempts = Math.max(job.attempts, 1);
    return run;
  }

  /**
   * Чекпоінт: результат кроку зафіксовано, і він більше не обчислюватиметься. Лічильник спроб
   * задачі між кроками дорівнює нулю. Наступну спробу зарахує startStep або нове захоплення.
   */
  async checkpoint(
    job: Job,
    run: StepRun,
    output: unknown,
  ): Promise<SavedCheckpoint> {
    const stored = this.storable(job, run.stepId, output);
    const saved = await this.db.run(job.tenantId, async (em) => {
      await this.queue.assertLease(em, job);
      return this.saveCheckpoint(em, job, run, stored);
    });
    job.attempts = 0;
    return saved;
  }

  private async saveCheckpoint(
    em: EntityManager,
    job: Job,
    run: StepRun,
    output: unknown,
  ): Promise<SavedCheckpoint> {
    const [rows]: [SavedCheckpoint[], number] = await em.query(
      `UPDATE step_runs SET status = 'succeeded', output = $2, error = NULL, "finishedAt" = now()
       WHERE id = $1 AND "tenantId" = $3 RETURNING output, "finishedAt"`,
      [run.id, JSON.stringify(output), job.tenantId],
    );
    await em.query(
      'UPDATE jobs SET attempts = 0 WHERE id = $1 AND "tenantId" = $2',
      [job.id, job.tenantId],
    );
    return rows[0];
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
    await this.db.run(job.tenantId, async (em) => {
      await this.queue.assertLease(em, job);
      await em.query(
        `UPDATE executions SET status = 'succeeded', output = $2, error = NULL, "finishedAt" = now()
          WHERE id = $1 AND "tenantId" = $3`,
        [
          job.executionId,
          JSON.stringify(toStorable(output).value),
          job.tenantId,
        ],
      );
      // Задача — останньою: її оновлення зачіпає облік тенанта (порядок блокувань).
      await this.queue.markLockedJobDone(em, job);
    });
  }

  /**
   * Спроба провалилась: стан кроку, задачі (повтор із backoff або кінець) і, якщо повторів не
   * буде, виконання — в одній транзакції.
   *
   * Стан береться з БД під блокуванням задачі, а не з того, що встиг отримати воркер: COMMIT
   * попередньої транзакції (startStep, чекпоінт) міг відбутися, хоча драйвер повернув помилку.
   * Блокування чекає на її результат і перевіряє, що lease досі наш, тож рядки кроків виконання
   * змінює лише ця спроба.
   */
  async fail(
    job: Job,
    run: StepRun | undefined,
    error: string,
    retryable: boolean,
    retryAfterMs?: number,
  ): Promise<FailureOutcome | 'checkpointed'> {
    // Текст помилки кроку може містити дані тенанта чи отримувача (напр., U+0000).
    error = toStorableText(error);
    return this.db.run(job.tenantId, async (em) => {
      const locked = await this.queue.assertLease(em, job);
      if (run) {
        const persisted = await em.findOneByOrFail(StepRun, {
          id: run.id,
          tenantId: job.tenantId,
        });
        if (persisted.status === 'succeeded') {
          await this.release(em, job);
          return 'checkpointed';
        }
      }
      // Крок, розпочатий цією спробою, — і тоді, коли відповідь startStep загубилася і воркер
      // його не знає (`run` = undefined). Кроки виконуються по черзі: такий рядок щонайбільше один.
      await em.query(
        `UPDATE step_runs SET status = 'failed', error = $2, "finishedAt" = now()
          WHERE "executionId" = $1 AND "tenantId" = $3 AND status = 'running'`,
        [job.executionId, error, job.tenantId],
      );
      const outcome = this.queue.failureOutcome(locked, retryable);
      if (outcome !== 'retry') {
        // Лічильник спроб — із БД: відповідь startStep, що зарахувала спробу, могла загубитися.
        const final =
          outcome === 'dead'
            ? `${error}; no attempts left (${locked.attempts}/${locked.maxAttempts})`
            : error;
        await em.query(
          `UPDATE executions SET status = 'failed', error = $2, "finishedAt" = now()
            WHERE id = $1 AND "tenantId" = $3`,
          [job.executionId, final, job.tenantId],
        );
      }
      // Задача — останньою: її оновлення зачіпає облік тенанта (порядок блокувань).
      await this.queue.applyFailure(em, locked, error, outcome, retryAfterMs);
      return outcome;
    });
  }

  /**
   * Довговічний таймер: фіксує момент пробудження кроку `delay` і повертає задачу в чергу з
   * `runAt` = цей момент, звільняючи lease. Слот воркера вільний; пробудження переживає будь-який
   * перезапуск, бо час зберігається в БД. Пауза — не спроба: лічильник спроб обнуляється.
   */
  async park(job: Job, run: StepRun, ms: number): Promise<Date> {
    return this.db.run(job.tenantId, async (em) => {
      await this.queue.assertLease(em, job);
      const [rows]: [Array<{ wakeAt: Date }>, number] = await em.query(
        `UPDATE step_runs SET "wakeAt" = now() + make_interval(secs => $2)
          WHERE id = $1 AND "tenantId" = $3 RETURNING "wakeAt"`,
        [run.id, ms / 1000, job.tenantId],
      );
      const { wakeAt } = rows[0];
      await this.release(em, job, wakeAt);
      return wakeAt;
    });
  }

  /**
   * Задачу кроку `delay` знову захоплено. Якщо момент пробудження настав — крок завершено
   * (чекпоінт), інакше (напр., задачу повернув reaper раніше строку) — паркуємо знову до того
   * самого моменту. Повертає записаний результат або null після паркування.
   */
  async wakeIfDue(
    job: Job,
    run: StepRun,
    output: unknown,
  ): Promise<SavedCheckpoint | null> {
    const saved = await this.db.run(job.tenantId, async (em) => {
      await this.queue.assertLease(em, job);
      const [{ due }]: Array<{ due: boolean }> = await em.query(
        `SELECT "wakeAt" <= now() AS due FROM step_runs WHERE id = $1 AND "tenantId" = $2`,
        [run.id, job.tenantId],
      );
      if (!due) {
        await this.release(em, job, run.wakeAt!);
        return null;
      }
      return this.saveCheckpoint(em, job, run, output);
    });
    if (saved) job.attempts = 0;
    return saved;
  }

  /** Повертає задачу в чергу до `runAt` без lease і без зарахованої спроби. */
  private async release(
    em: EntityManager,
    job: Job,
    runAt?: Date,
  ): Promise<void> {
    await em.query(
      `UPDATE jobs
          SET status = 'queued', "runAt" = COALESCE($2, now()), attempts = 0,
              "lockedBy" = NULL, "lockedUntil" = NULL, "lockToken" = NULL
        WHERE id = $1 AND "tenantId" = $3`,
      [job.id, runAt ?? null, job.tenantId],
    );
  }
}
