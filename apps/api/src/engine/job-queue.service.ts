import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { EnvironmentVariables } from '../config/env.validation';
import { Job } from '../entities';

export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  /** Джерело випадковості в [0, 1); у тестах — підставне. */
  random?: () => number;
}

/**
 * Затримка перед повтором після спроби `attempt` (1, 2, …): випадкова в межах
 * [base, min(max, base·2^attempt)] — експоненційна межа з «повним» jitter і нижньою межею base.
 * Jitter розносить у часі повтори задач, що впали одночасно (масовий збій отримувача), замість
 * хвилі повторів в один момент; верхня межа не дає затримці рости без кінця.
 */
export function backoffMs(
  attempt: number,
  { baseMs, maxMs, random = Math.random }: BackoffOptions,
): number {
  // Степінь обмежено: 2^1100 — це Infinity, а межа й так досягається значно раніше.
  const ceiling = Math.max(
    baseMs,
    Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 64)),
  );
  return Math.round(baseMs + random() * (ceiling - baseMs));
}

/**
 * Затримка повтору з урахуванням побажання отримувача (`Retry-After`): не раніше, ніж він просить,
 * не коротша за звичайний backoff (його нижня межа і jitter лишаються) і не довша за `maxMs` —
 * отримувач не може відкласти задачу довше, ніж дозволяє конфігурація.
 */
export function retryDelayMs(
  attempt: number,
  options: BackoffOptions,
  notBeforeMs?: number,
): number {
  return Math.min(
    options.maxMs,
    Math.max(notBeforeMs ?? 0, backoffMs(attempt, options)),
  );
}

/** Lease задачі вже забрано (прострочено й повернуто в чергу reaper-ом або захоплено іншим). */
export class LeaseLostError extends Error {
  constructor(jobId: string) {
    super(`lease on job ${jobId} is no longer held by this worker`);
  }
}

/** Захоплена задача: момент захоплення — за годинником БД (для метрики затримки захоплення). */
export type ClaimedJob = Job & { claimedAt: Date };

/** Задача, повернута reaper-ом після простроченого lease. */
export interface ReapedJob {
  id: string;
  executionId: string;
  correlationId: string | null;
  attempts: number;
  outcome: 'retry' | 'dead';
}

export type FailureOutcome = 'retry' | 'failed' | 'dead';

/** Скільки прострочених задач reaper обробляє за одну транзакцію. */
const REAP_BATCH = 100;

/**
 * Найраніша готова задача (індекс IDX_jobs_claim). Винесено в константу, щоб тест плану запиту
 * перевіряв саме той SQL, що виконується.
 */
export const CLAIM_CANDIDATE_SQL = `
  SELECT id FROM jobs
   WHERE status = 'queued' AND "runAt" <= now()
   ORDER BY "runAt"
   LIMIT 1
   FOR UPDATE SKIP LOCKED`;

/** Задачі з простроченим lease (індекс IDX_jobs_lease). */
export const EXPIRED_LEASES_SQL = `
  SELECT * FROM jobs
   WHERE status = 'running' AND "lockedUntil" < now()
   ORDER BY "lockedUntil"
   LIMIT ${REAP_BATCH}
   FOR UPDATE SKIP LOCKED`;

/** Скільки завершених задач видаляє одна транзакція очищення. */
export const PURGE_BATCH = 1000;

/**
 * Пачка завершених задач, старших за термін зберігання ($1 — днів), найстаріші першими (індекс
 * IDX_jobs_finished). SKIP LOCKED: очищення в кількох воркерах не чекає одне на одного.
 */
export const FINISHED_JOBS_SQL = `
  SELECT id FROM jobs
   WHERE status IN ('done', 'failed', 'dead')
     AND "finishedAt" < now() - make_interval(days => $1)
   ORDER BY "finishedAt"
   LIMIT ${PURGE_BATCH}
   FOR UPDATE SKIP LOCKED`;

/**
 * Видалення однієї пачки завершених задач (FINISHED_JOBS_SQL), $1 — днів зберігання. Саме
 * `= ANY (ARRAY(...))`, а не `IN (...)`: для `IN` планувальник обирає hash semi join із
 * послідовним читанням усієї таблиці на кожну пачку, а масив id дає пошук за первинним ключем.
 */
export const PURGE_FINISHED_SQL = `DELETE FROM jobs WHERE id = ANY (ARRAY(${FINISHED_JOBS_SQL}))`;

/** Скільки завершених виконань (з кроками й задачами) видаляє одна транзакція очищення історії. */
export const HISTORY_PURGE_BATCH = 500;

/**
 * Пачка завершених виконань, старших за термін зберігання історії ($1 — днів), найстаріші першими
 * (індекс IDX_executions_finished). Повтор виконання (`retry`) блокує рядок — SKIP LOCKED його
 * пропустить, а після коміту воно вже не завершене.
 */
export const FINISHED_EXECUTIONS_SQL = `
  SELECT id FROM executions
   WHERE status IN ('succeeded', 'failed')
     AND "finishedAt" < now() - make_interval(days => $1)
   ORDER BY "finishedAt"
   LIMIT ${HISTORY_PURGE_BATCH}
   FOR UPDATE SKIP LOCKED`;

/**
 * Одна пачка історії одним оператором (атомарно): кроки, задачі й самі виконання. Видалення —
 * за ключами (`= ANY`), без читання таблиць повністю.
 */
export const PURGE_EXECUTIONS_SQL = `
  WITH batch AS (SELECT ARRAY(${FINISHED_EXECUTIONS_SQL}) AS ids),
       steps AS (DELETE FROM step_runs s USING batch b WHERE s."executionId" = ANY (b.ids)),
       queue AS (DELETE FROM jobs j USING batch b WHERE j."executionId" = ANY (b.ids))
  DELETE FROM executions e USING batch b WHERE e.id = ANY (b.ids)`;

@Injectable()
export class JobQueueService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {}

  /** Затримка перед наступною спробою, у секундах (для make_interval). */
  private retryDelaySeconds(attempt: number, notBeforeMs?: number): number {
    return (
      retryDelayMs(
        attempt,
        {
          baseMs: this.config.get('JOB_BACKOFF_BASE_MS', { infer: true }),
          maxMs: this.config.get('JOB_BACKOFF_MAX_MS', { infer: true }),
        },
        notBeforeMs,
      ) / 1000
    );
  }

  /** Тривалість lease у секундах (для make_interval). */
  private get leaseSeconds(): number {
    return this.config.get('JOB_LEASE_MS', { infer: true }) / 1000;
  }

  /**
   * Атомарно захоплює наступну готову задачу, або повертає null.
   *
   * Вибір і захоплення — один оператор: `FOR UPDATE SKIP LOCKED` блокує вибраний рядок до кінця
   * оператора, а конкурентні воркери пропускають заблоковані рядки й беруть наступні, тож одну
   * задачу не може отримати двоє. `RETURNING *` повертає вже оновлений рядок. Кожне захоплення
   * видає новий fencing-токен `lockToken`. Увесь час — за годинником БД, не процесу.
   */
  async claimNext(workerId: string): Promise<ClaimedJob | null> {
    const [rows]: [ClaimedJob[], number] = await this.ds.query(
      `UPDATE jobs
          SET status = 'running', "lockedBy" = $1, "lockToken" = gen_random_uuid(),
              "lockedUntil" = now() + make_interval(secs => $2),
              attempts = attempts + 1
        WHERE id = (${CLAIM_CANDIDATE_SQL})
        RETURNING *, now() AS "claimedAt"`,
      [workerId, this.leaseSeconds],
    );
    return rows[0] ?? null;
  }

  /**
   * Продовжує lease. false — lease уже не наш (задачу повернув reaper або захопив інший воркер):
   * воркер мусить припинити роботу над нею без жодних записів.
   */
  async heartbeat(job: Job): Promise<boolean> {
    const [rows]: [unknown[], number] = await this.ds.query(
      `UPDATE jobs SET "lockedUntil" = now() + make_interval(secs => $3)
        WHERE id = $1 AND "lockToken" = $2 AND status = 'running'
        RETURNING id`,
      [job.id, job.lockToken, this.leaseSeconds],
    );
    return rows.length === 1;
  }

  /**
   * Перевіряє в транзакції `em`, що lease досі наш, і блокує рядок задачі до кінця транзакції
   * (reaper і heartbeat чекатимуть) і повертає його поточний стан. Кидає LeaseLostError —
   * транзакцію буде відкочено.
   */
  async assertLease(em: EntityManager, job: Job): Promise<Job> {
    const rows: Job[] = await em.query(
      `SELECT * FROM jobs
        WHERE id = $1 AND "lockToken" = $2 AND status = 'running'
        FOR UPDATE`,
      [job.id, job.lockToken],
    );
    if (rows.length !== 1) throw new LeaseLostError(job.id);
    return rows[0];
  }

  /**
   * Позначає задачу виконаною в транзакції `em` викликача (разом із завершенням виконання).
   * Кидає LeaseLostError, якщо lease уже не наш.
   */
  async completeIn(em: EntityManager, job: Job): Promise<void> {
    await this.assertLease(em, job);
    await em.query(
      `UPDATE jobs SET status = 'done', "lockedBy" = NULL, "lockedUntil" = NULL, "lockToken" = NULL,
                       "finishedAt" = now()
        WHERE id = $1`,
      [job.id],
    );
  }

  /**
   * Повертає задачу в чергу одразу, без зарахованої спроби (завершення воркера): робота не
   * провалилась, її просто перервали. Продовження — з останнього чекпоінта.
   */
  async release(job: Job): Promise<void> {
    await this.ds.transaction(async (em) => {
      await this.assertLease(em, job);
      await em.query(
        `UPDATE jobs
            SET status = 'queued', "runAt" = now(), attempts = GREATEST(attempts - 1, 0),
                "lockedBy" = NULL, "lockedUntil" = NULL, "lockToken" = NULL
          WHERE id = $1`,
        [job.id],
      );
    });
  }

  /**
   * Провал спроби в транзакції `em` викликача (разом зі станом кроку й виконання):
   * - `retry` — повторювана помилка, спроби лишились: у черзі з backoff;
   * - `failed` — неповторювана помилка: повтор нічого не змінить;
   * - `dead` — повторювана помилка, але ліміт спроб вичерпано (окремий стан для розбору).
   */
  async failIn(
    em: EntityManager,
    job: Job,
    error: string,
    retryable: boolean,
    retryAfterMs?: number,
  ): Promise<FailureOutcome> {
    const current = await this.assertLease(em, job);
    const outcome: FailureOutcome = !retryable
      ? 'failed'
      : current.attempts < current.maxAttempts
        ? 'retry'
        : 'dead';
    await this.applyFailure(em, current, error, outcome, retryAfterMs);
    return outcome;
  }

  private async applyFailure(
    em: EntityManager,
    job: Job,
    error: string,
    outcome: FailureOutcome,
    retryAfterMs?: number,
  ): Promise<void> {
    if (outcome === 'retry') {
      await em.query(
        `UPDATE jobs
            SET status = 'queued', "lockedBy" = NULL, "lockedUntil" = NULL, "lockToken" = NULL,
                "lastError" = $2, "runAt" = now() + make_interval(secs => $3)
          WHERE id = $1`,
        [job.id, error, this.retryDelaySeconds(job.attempts, retryAfterMs)],
      );
      return;
    }
    await em.query(
      `UPDATE jobs
          SET status = $3, "lockedBy" = NULL, "lockedUntil" = NULL, "lockToken" = NULL,
              "lastError" = $2, "finishedAt" = now()
        WHERE id = $1`,
      [job.id, error, outcome],
    );
  }

  /**
   * Повертає в чергу задачі, чий lease минув (воркер упав, завис або втратив зв'язок із БД).
   * Прострочений lease рахується як спроба: задача, що раз у раз валить воркер («отруйна»),
   * вичерпає спроби, а не крутитиметься вічно; повтор — із тим самим backoff, що й після помилки.
   * Рядки беруться через SKIP LOCKED: кілька reaper-ів і захоплення не заважають одне одному.
   * Пачки по REAP_BATCH (кожна — окрема коротка транзакція) — доки пачка неповна: після масового
   * падіння воркерів усі їхні задачі повертаються за один прохід, а не по 100 раз на `lease/2`.
   */
  async reapExpired(signal?: AbortSignal): Promise<ReapedJob[]> {
    const reaped: ReapedJob[] = [];
    while (!signal?.aborted) {
      const batch = await this.reapBatch();
      reaped.push(...batch);
      if (batch.length < REAP_BATCH) break;
    }
    return reaped;
  }

  private async reapBatch(): Promise<ReapedJob[]> {
    return this.ds.transaction(async (em) => {
      const expired: Job[] = await em.query(EXPIRED_LEASES_SQL);
      const reaped: ReapedJob[] = [];
      for (const job of expired) {
        const error = `lease expired: worker ${job.lockedBy ?? '?'} stopped renewing it`;
        const outcome: FailureOutcome =
          job.attempts < job.maxAttempts ? 'retry' : 'dead';
        await this.applyFailure(em, job, error, outcome);
        if (outcome === 'dead') {
          const final = `${error}; no attempts left (${job.attempts}/${job.maxAttempts})`;
          await em.query(
            `UPDATE step_runs SET status = 'failed', error = $2, "finishedAt" = now()
              WHERE "executionId" = $1 AND status = 'running'`,
            [job.executionId, final],
          );
          await em.query(
            `UPDATE executions SET status = 'failed', error = $2, "finishedAt" = now()
              WHERE id = $1`,
            [job.executionId, final],
          );
        }
        reaped.push({
          id: job.id,
          executionId: job.executionId,
          correlationId: job.correlationId,
          attempts: job.attempts,
          outcome,
        });
      }
      return reaped;
    });
  }

  /**
   * Видаляє завершені задачі (`done`, `failed`, `dead`), що завершились понад `retentionDays` днів
   * тому, пачками по PURGE_BATCH — кожна пачка окремою короткою транзакцією, без довгих блокувань.
   * Виконання й кроки не видаляються: це історія тенанта, яку показує API. Повертає кількість.
   */
  /**
   * Видаляє історію виконань, завершених понад `retentionDays` днів тому: пачками по
   * HISTORY_PURGE_BATCH, кожна — один оператор (кроки, задачі й виконання разом або ніяк).
   * Повертає кількість видалених виконань.
   */
  async purgeExecutions(
    retentionDays: number,
    signal?: AbortSignal,
  ): Promise<number> {
    let total = 0;
    while (!signal?.aborted) {
      const [, deleted]: [unknown[], number] = await this.ds.query(
        PURGE_EXECUTIONS_SQL,
        [retentionDays],
      );
      total += deleted;
      if (deleted < HISTORY_PURGE_BATCH) break;
    }
    return total;
  }

  async purgeFinished(
    retentionDays: number,
    signal?: AbortSignal,
  ): Promise<number> {
    let total = 0;
    while (!signal?.aborted) {
      const [, deleted]: [unknown[], number] = await this.ds.query(
        PURGE_FINISHED_SQL,
        [retentionDays],
      );
      total += deleted;
      if (deleted < PURGE_BATCH) break;
    }
    return total;
  }
}
