import { StepError } from './step-error';
import { CONTEXT_BYTES } from './transform-profile';
import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { toStorable, toStorableText } from '../common/storable-text';
import { Job, StepDefinition, StepRun } from '../entities';
import { TenantDb } from '../tenancy/tenant-db';
import {
  FailureOutcome,
  HELD_JOB,
  JobQueueService,
  LeaseLostError,
} from './job-queue.service';

interface SavedCheckpoint {
  output: unknown;
  finishedAt: Date;
}

/** Стан виконання для відновлення задачі (CheckpointService.resume). */
export interface ResumeState {
  input: Record<string, unknown>;
  /** Кроки зафіксованої версії; null — у виконання немає знімка. */
  steps: StepDefinition[] | null;
  history: StepRun[];
}

/**
 * Початок спроби кроку одним оператором ($1 — задача, $2 — тенант, $3 — fencing-токен,
 * $4 — виконання, $5 — індекс, $6 — id кроку). Порядок блокувань — як у FINISH_EXECUTION_SQL:
 * `held` блокує задачу першою, а кожна наступна зміна залежить від попередньої через EXISTS, тож
 * крок і виконання блокуються після задачі (docs/architecture.md, «Порядок блокувань»). Lease
 * уже не наш — порожній результат і жодних змін.
 */
export const START_STEP_SQL = `WITH held AS (
    SELECT id FROM jobs ${HELD_JOB} FOR UPDATE
  ), counted AS (
    UPDATE jobs SET attempts = 1
     WHERE id = $1 AND "tenantId" = $2 AND attempts = 0 AND EXISTS (SELECT 1 FROM held)
  ), run AS (
    INSERT INTO step_runs ("executionId", "tenantId", "stepIndex", "stepId", status, attempts)
    SELECT $4::uuid, $2::uuid, $5::integer, $6::text, 'running', 1 WHERE EXISTS (SELECT 1 FROM held)
    ON CONFLICT ("executionId", "stepIndex") DO UPDATE
       SET status = 'running', attempts = step_runs.attempts + 1, error = NULL, "finishedAt" = NULL
    RETURNING *
  ), started AS (
    UPDATE executions SET status = 'running'
     WHERE id = $4 AND "tenantId" = $2 AND status = 'pending' AND EXISTS (SELECT 1 FROM run)
  )
  SELECT * FROM run`;

/**
 * Чекпоінт одним оператором ($1 — задача, $2 — тенант, $3 — fencing-токен, $4 — рядок кроку,
 * $5 — результат): lease, результат кроку й обнулення лічильника спроб задачі. Рядок результату
 * є завжди: `held` — чи lease ще наш, `finishedAt` — null, якщо крок не збережено.
 */
function checkpointSql(onlyIfDue: boolean): string {
  return `WITH held AS (
    SELECT id FROM jobs ${HELD_JOB} FOR UPDATE
  ), saved AS (
    UPDATE step_runs SET status = 'succeeded', output = $5, error = NULL, "finishedAt" = now()
     WHERE id = $4 AND "tenantId" = $2 AND EXISTS (SELECT 1 FROM held)${
       onlyIfDue ? ' AND "wakeAt" <= now()' : ''
     }
    RETURNING output, "finishedAt"
  ), reset AS (
    UPDATE jobs SET attempts = 0
     WHERE id = $1 AND "tenantId" = $2 AND EXISTS (SELECT 1 FROM saved)
  )
  SELECT EXISTS (SELECT 1 FROM held) AS held, saved.output, saved."finishedAt"
    FROM (VALUES (1)) AS one LEFT JOIN saved ON true`;
}

export const CHECKPOINT_SQL = checkpointSql(false);
/** Те саме для кроку `delay`: результат зберігається, лише якщо момент пробудження настав. */
export const CHECKPOINT_IF_DUE_SQL = checkpointSql(true);

/**
 * Записи про перебіг кроків. Кожен метод — одна транзакція, що спершу перевіряє lease задачі
 * (перевірка токена під блокуванням рядка job): воркер, чий lease уже забрали, нічого не запише, а стан
 * кількох таблиць змінюється разом або ніяк.
 */
@Injectable()
export class CheckpointService {
  private readonly logger = new Logger(CheckpointService.name);

  constructor(
    private readonly db: TenantDb,
    private readonly queue: JobQueueService,
  ) {}

  /**
   * Стан для відновлення задачі одним знімком у контексті її тенанта: вхід виконання, кроки
   * зафіксованої версії (null — знімка немає) і чекпоінти за порядком кроків. Виконання, версія й
   * сумарний розмір збережених результатів — одним запитом; самі результати читаються лише тоді,
   * коли їхній розмір у межах: історичні необмежені результати не передаються драйверу.
   */
  async resume(em: EntityManager, job: Job): Promise<ResumeState> {
    const [row]: Array<{
      input: Record<string, unknown>;
      steps: StepDefinition[] | null;
      oversize: boolean;
    }> = await em.query(
      `SELECT e.input, v.steps,
              (SELECT COALESCE(sum(octet_length(r.output::text)), 0) > $3
                 FROM step_runs r WHERE r."executionId" = e.id AND r."tenantId" = e."tenantId") AS oversize
         FROM executions e
         LEFT JOIN workflow_versions v ON v.id = e."workflowVersionId" AND v."tenantId" = e."tenantId"
        WHERE e.id = $1 AND e."tenantId" = $2`,
      [job.executionId, job.tenantId, 3 * CONTEXT_BYTES],
    );
    if (!row) throw new Error(`execution ${job.executionId} is not visible`);
    if (row.oversize)
      throw new StepError('step context exceeds the byte limit', false);
    return {
      input: row.input,
      steps: row.steps,
      history: await this.history(em, job),
    };
  }

  /**
   * Чекпоінти виконання задачі за порядком кроків, з явним предикатом тенанта (перший шар
   * ізоляції, `tenant-predicates.int-spec.ts`), у транзакції `em` викликача.
   */
  history(em: EntityManager, job: Job): Promise<StepRun[]> {
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
    const [run]: StepRun[] = await this.db.run(job.tenantId, (em) =>
      em.query(START_STEP_SQL, [
        job.id,
        job.tenantId,
        job.lockToken,
        job.executionId,
        stepIndex,
        stepId,
      ]),
    );
    if (!run) throw new LeaseLostError(job.id);
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
    const saved = await this.db.run(job.tenantId, (em) =>
      this.saveCheckpoint(em, job, run, stored, false),
    );
    if (!saved) throw new Error(`step run ${run.id} is missing`);
    job.attempts = 0;
    return saved;
  }

  /**
   * Чекпоінт одним оператором (CHECKPOINT_SQL): lease, результат кроку й обнулення лічильника
   * спроб. Кидає LeaseLostError, якщо lease уже не наш; null — крок не збережено, бо `onlyIfDue`
   * і момент пробудження ще не настав (рядок задачі при цьому заблоковано до кінця транзакції).
   */
  private async saveCheckpoint(
    em: EntityManager,
    job: Job,
    run: StepRun,
    output: unknown,
    onlyIfDue: boolean,
  ): Promise<SavedCheckpoint | null> {
    const [row]: Array<{
      held: boolean;
      output: unknown;
      finishedAt: Date | null;
    }> = await em.query(onlyIfDue ? CHECKPOINT_IF_DUE_SQL : CHECKPOINT_SQL, [
      job.id,
      job.tenantId,
      job.lockToken,
      run.id,
      JSON.stringify(output),
    ]);
    if (!row.held) throw new LeaseLostError(job.id);
    return row.finishedAt
      ? { output: row.output, finishedAt: row.finishedAt }
      : null;
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
    const result = { output: JSON.stringify(toStorable(output).value) ?? null };
    await this.db.run(job.tenantId, (em) =>
      this.queue.completeIn(em, job, result),
    );
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
      const checkpoint = await this.saveCheckpoint(em, job, run, output, true);
      // Момент пробудження ще не настав (напр., задачу повернув reaper раніше строку).
      if (!checkpoint) await this.release(em, job, run.wakeAt!);
      return checkpoint;
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
