import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EntityManager } from 'typeorm';
import { EnvironmentVariables } from '../config/env.validation';
import { Job } from '../entities';
import { SystemDb } from '../tenancy/system-db';
import { TenantDb } from '../tenancy/tenant-db';
import { QueueMetrics } from './queue.metrics';

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
 * обмежена зверху `maxMs`. Якщо підказка переважає випадковий backoff, затримка фіксована —
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
export type ClaimedJob = Job & { claimedAt: Date; leaseStartedAt: number };

/** Задача, повернута reaper-ом після простроченого lease. */
export interface ReapedJob {
  id: string;
  executionId: string;
  correlationId: string | null;
  attempts: number;
  outcome: 'retry' | 'dead' | 'done';
}

export type FailureOutcome = 'retry' | 'failed' | 'dead';

/** Скільки прострочених задач reaper обробляє за одну транзакцію. */
const REAP_BATCH = 100;
/** Скільки тенантів із простроченими lease reaper бере за один запит. */
const REAP_TENANTS = 100;

/** Скільки тенантів одна промоція переводить до індексу готових. */
const PROMOTE_BATCH = 100;
/**
 * Скільки спроб робить одне захоплення, поки кандидата щойно обслуговує інший воркер. Після них
 * цикл воркера одразу пробує знову (без паузи опитування): невдала спроба означає, що система
 * просувається — задачу взяв хтось інший.
 */
const CLAIM_ATTEMPTS = 10;
/** Найдовше очікування рядка обліку тенанта-кандидата (його тримають лише короткі транзакції). */
const CLAIM_LOCK_TIMEOUT = '2s';
/** SQLSTATE lock_not_available: lock_timeout вичерпано. */
const LOCK_NOT_AVAILABLE = '55P03';

/**
 * Найраніша готова задача тенанта ($1) — індекс IDX_jobs_tenant_queue; виконується під RLS у
 * контексті цього тенанта. Константа — для тесту плану запиту.
 */
export const CLAIM_CANDIDATE_SQL = `
  SELECT id FROM jobs
   WHERE "tenantId" = $1 AND status = 'queued' AND "runAt" <= clock_timestamp()
   ORDER BY "runAt"
   LIMIT 1
   FOR UPDATE SKIP LOCKED`;

/** Задачі тенанта ($1) з простроченим lease (індекс IDX_jobs_lease); виконується під RLS. */
export const EXPIRED_LEASES_SQL = `
  SELECT * FROM jobs
   WHERE status = 'running' AND "lockedUntil" < now() AND "tenantId" = $1
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

/**
 * Черга задач. Кросс-тенантні кроки (пошук кандидата на захоплення, тенантів із простроченими
 * lease, очищення) — вузькі SECURITY DEFINER-функції; усе інше — у транзакції з контекстом
 * тенанта задачі (RLS) і з явним предикатом `tenantId`.
 */
@Injectable()
export class JobQueueService {
  constructor(
    private readonly db: TenantDb,
    private readonly system: SystemDb,
    private readonly config: ConfigService<EnvironmentVariables, true>,
    @Optional() private readonly metrics?: QueueMetrics,
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
   * Захоплює наступну задачу справедливо між тенантами (README, 3.3.5) або повертає null (готових
   * задач немає) чи undefined (кандидатів щойно забирали інші воркери — варто одразу спробувати
   * знову).
   *
   * 1. Промоція (окремий оператор, SKIP LOCKED): дозрілі тенанти стають членами індексу готових.
   * 2. Спроба — одна транзакція: `claim_candidate` обирає тенанта з найменшою кількістю задач у
   *    роботі, а серед рівних — найдавніше обслуженого; далі контекст цього тенанта, очікування
   *    його рядка обліку (без SKIP LOCKED, з lock_timeout) і перевірка свіжості під блокуванням:
   *    кандидат досі готовий, ненасичений і не обслужений, відколи його обрали. Тоді найраніша
   *    готова задача захоплюється (SKIP LOCKED); тригер збільшує `running` і записує момент
   *    обслуговування під уже взятим блокуванням, тож ліміт одночасних задач жорсткий.
   * 3. Кандидата обслужив інший воркер — нова спроба в новій транзакції (транзакція не тримає двох
   *    рядків обліку). Задачі не знайшлося — облік перераховується, кандидат виключається.
   *
   * Кожне захоплення видає новий fencing-токен `lockToken`. Увесь час — за годинником БД.
   */
  async claimNext(workerId: string): Promise<ClaimedJob | null | undefined> {
    const stop = this.metrics?.claimDuration.startTimer();
    try {
      await this.system.promoteReadyTenants(PROMOTE_BATCH);
      const exclude: string[] = [];
      for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
        const outcome = await this.claimAttempt(workerId, exclude);
        if (outcome.kind === 'claimed') return outcome.job;
        if (outcome.kind === 'empty') return null;
        this.metrics?.claimContention.inc({ reason: outcome.kind });
        // Облік перераховано або рядок тримають довше за lock_timeout (ненормально довга
        // транзакція тенанта): до кінця цього захоплення кандидат виключається, щоб не чекати на
        // нього знову й не зупиняти обслуговування інших.
        if (outcome.kind !== 'stale') exclude.push(outcome.tenantId);
      }
      return undefined;
    } finally {
      stop?.();
    }
  }

  private async claimAttempt(
    workerId: string,
    exclude: string[],
  ): Promise<
    | { kind: 'claimed'; job: ClaimedJob }
    | { kind: 'empty' }
    | { kind: 'stale' }
    | { kind: 'repair' | 'lock_timeout'; tenantId: string }
  > {
    let tenantId: string | undefined;
    try {
      return await this.db.transaction(async (tx) => {
        await tx.em.query(`SET LOCAL lock_timeout = '${CLAIM_LOCK_TIMEOUT}'`);
        const [candidate]: Array<{ tenantId: string; lastClaimedAt: string }> =
          await tx.em.query('SELECT * FROM claim_candidate($1::uuid[])', [
            exclude,
          ]);
        if (!candidate) return { kind: 'empty' as const };
        tenantId = candidate.tenantId;
        await tx.enter(candidate.tenantId);
        const [usage]: Array<{
          running: number;
          maxRunning: number;
          due: boolean;
          lastClaimedAt: string;
        }> = await tx.em.query('SELECT * FROM lock_tenant_usage()');
        if (
          !usage.due ||
          usage.running >= usage.maxRunning ||
          usage.lastClaimedAt !== candidate.lastClaimedAt
        )
          return { kind: 'stale' as const };
        // Lease починається з цього оператора, а не з початку транзакції чи захоплення: очікування
        // рядка обліку не скорочує lease ні в БД (clock_timestamp, а не now()), ні в воркера
        // (локальний відлік — до надсилання оператора, тобто не пізніше за БД).
        const leaseStartedAt = performance.now();
        const [rows]: [(Job & { claimedAt: Date })[], number] =
          await tx.em.query(
            `UPDATE jobs
                SET status = 'running', "lockedBy" = $1, "lockToken" = gen_random_uuid(),
                    "lockedUntil" = clock_timestamp() + make_interval(secs => $2),
                    attempts = attempts + 1
              WHERE id = (${CLAIM_CANDIDATE_SQL.replace('$1', '$3')}) AND "tenantId" = $3
              RETURNING *, clock_timestamp() AS "claimedAt"`,
            [workerId, this.leaseSeconds, candidate.tenantId],
          );
        if (rows[0])
          return {
            kind: 'claimed' as const,
            job: { ...rows[0], leaseStartedAt },
          };
        // Облік казав, що готова задача є, а її немає: перерахувати з фактичних задач.
        await tx.em.query('SELECT refresh_tenant_usage()');
        return { kind: 'repair' as const, tenantId: candidate.tenantId };
      });
    } catch (err) {
      if ((err as { code?: string }).code === LOCK_NOT_AVAILABLE && tenantId)
        return { kind: 'lock_timeout', tenantId };
      throw err;
    }
  }

  /**
   * Продовжує lease. false — lease уже не наш (задачу повернув reaper або захопив інший воркер):
   * воркер мусить припинити роботу над нею без жодних записів.
   */
  async heartbeat(job: Job): Promise<boolean> {
    const [rows]: [unknown[], number] = await this.db.run(job.tenantId, (em) =>
      em.query(
        `UPDATE jobs SET "lockedUntil" = now() + make_interval(secs => $3)
          WHERE id = $1 AND "lockToken" = $2 AND status = 'running' AND "tenantId" = $4
          RETURNING id`,
        [job.id, job.lockToken, this.leaseSeconds, job.tenantId],
      ),
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
        WHERE id = $1 AND "lockToken" = $2 AND status = 'running' AND "tenantId" = $3
        FOR UPDATE`,
      [job.id, job.lockToken, job.tenantId],
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
    await this.markLockedJobDone(em, job);
  }

  /**
   * Задача виконана; викликач уже заблокував рядок через assertLease або вибірку прострочених
   * задач. Це оновлення `jobs` зачіпає облік тенанта (тригер), тож у транзакції воно — останнє
   * (README, «Порядок блокувань»).
   */
  async markLockedJobDone(em: EntityManager, job: Job): Promise<void> {
    await em.query(
      `UPDATE jobs SET status = 'done', attempts = GREATEST(attempts, 1), "lockedBy" = NULL, "lockedUntil" = NULL, "lockToken" = NULL,
                       "finishedAt" = now()
        WHERE id = $1 AND "tenantId" = $2`,
      [job.id, job.tenantId],
    );
  }

  /**
   * Повертає задачу в чергу одразу, без зарахованої спроби (завершення воркера): робота не
   * провалилась, її просто перервали. Продовження — з останнього чекпоінта.
   */
  async release(job: Job): Promise<void> {
    await this.db.run(job.tenantId, async (em) => {
      await this.assertLease(em, job);
      await em.query(
        `UPDATE jobs
            SET status = 'queued', "runAt" = now(), attempts = GREATEST(attempts - 1, 0),
                "lockedBy" = NULL, "lockedUntil" = NULL, "lockToken" = NULL
          WHERE id = $1 AND "tenantId" = $2`,
        [job.id, job.tenantId],
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
    const outcome = this.failureOutcome(current, retryable);
    await this.applyFailure(em, current, error, outcome, retryAfterMs);
    return outcome;
  }

  /** Наслідок провалу спроби для задачі в стані `locked` (рядок, заблокований assertLease). */
  failureOutcome(locked: Job, retryable: boolean): FailureOutcome {
    return !retryable
      ? 'failed'
      : locked.attempts < locked.maxAttempts
        ? 'retry'
        : 'dead';
  }

  /**
   * Записує наслідок провалу в рядок задачі, вже заблокований викликачем. Оновлення `jobs`
   * зачіпає облік тенанта (тригер), тож у транзакції воно — останнє.
   */
  async applyFailure(
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
          WHERE id = $1 AND "tenantId" = $4`,
        [
          job.id,
          error,
          this.retryDelaySeconds(job.attempts, retryAfterMs),
          job.tenantId,
        ],
      );
      return;
    }
    await em.query(
      `UPDATE jobs
          SET status = $3, "lockedBy" = NULL, "lockedUntil" = NULL, "lockToken" = NULL,
              "lastError" = $2, "finishedAt" = now()
        WHERE id = $1 AND "tenantId" = $4`,
      [job.id, error, outcome, job.tenantId],
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
    // Тенант, оброблений у цьому проході, але досі в переліку (його задачі тримає інший reaper,
    // SKIP LOCKED), наступний прохід перевірить знову — тут не зациклюємося на ньому.
    const visited = new Set<string>();
    while (!signal?.aborted) {
      // Тенанти в сталому порядку (за id): reaper-и різних воркерів обробляють їх в одній
      // послідовності.
      const tenants = await this.system.expiredLeaseTenants(
        [...visited],
        REAP_TENANTS,
      );
      if (tenants.length === 0) break;
      for (const tenantId of tenants) {
        if (signal?.aborted) break;
        visited.add(tenantId);
        for (;;) {
          const batch = await this.reapBatch(tenantId);
          reaped.push(...batch);
          if (batch.length < REAP_BATCH || signal?.aborted) break;
        }
      }
    }
    return reaped;
  }

  /** Якщо всі кроки зі знімка вже закомічені, лишився лише запис кінцевого стану.
   * Reaper тримає блокування job. Вихід останнього кроку копіюється всередині БД. */
  private async finishCheckpointed(
    em: EntityManager,
    job: Job,
  ): Promise<boolean> {
    const [, finished]: [unknown[], number] = await em.query(
      `UPDATE executions e SET status = 'succeeded', output = last.output, error = NULL, "finishedAt" = now()
         FROM workflow_versions v, step_runs last
        WHERE e.id = $1 AND e."tenantId" = $2 AND v.id = e."workflowVersionId"
          AND last."executionId" = e.id AND last."stepIndex" = jsonb_array_length(v.steps) - 1
          AND NOT EXISTS (
            SELECT FROM step_runs r WHERE r."executionId" = e.id
              AND (r."stepIndex" < 0 OR r."stepIndex" >= jsonb_array_length(v.steps))
          )
          AND NOT EXISTS (
            SELECT FROM jsonb_array_elements(v.steps) WITH ORDINALITY AS step(definition, n)
             WHERE NOT EXISTS (
               SELECT FROM step_runs r WHERE r."executionId" = e.id AND r."stepIndex" = step.n - 1
                 AND r."stepId" = step.definition->>'id' AND r.status = 'succeeded'
             )
          )`,
      [job.executionId, job.tenantId],
    );
    if (!finished) return false;
    await this.markLockedJobDone(em, job);
    return true;
  }

  private async reapBatch(tenantId: string): Promise<ReapedJob[]> {
    return this.db.run(tenantId, async (em) => {
      const expired: Job[] = await em.query(EXPIRED_LEASES_SQL, [tenantId]);
      const reaped: ReapedJob[] = [];
      for (const job of expired) {
        const error = `lease expired: worker ${job.lockedBy ?? '?'} stopped renewing it`;
        let outcome: ReapedJob['outcome'];
        if (await this.finishCheckpointed(em, job)) {
          outcome = 'done';
        } else {
          outcome = job.attempts < job.maxAttempts ? 'retry' : 'dead';
        }
        if (outcome === 'dead') {
          const final = `${error}; no attempts left (${job.attempts}/${job.maxAttempts})`;
          await em.query(
            `UPDATE step_runs SET status = 'failed', error = $2, "finishedAt" = now()
              WHERE "executionId" = $1 AND "tenantId" = $3 AND status = 'running'`,
            [job.executionId, final, tenantId],
          );
          await em.query(
            `UPDATE executions SET status = 'failed', error = $2, "finishedAt" = now()
              WHERE id = $1 AND "tenantId" = $3`,
            [job.executionId, final, tenantId],
          );
        }
        // Задача — останньою: її оновлення зачіпає облік тенанта (порядок блокувань).
        if (outcome !== 'done')
          await this.applyFailure(em, job, error, outcome);
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
      const deleted = await this.system.purgeExecutionHistory(
        retentionDays,
        HISTORY_PURGE_BATCH,
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
      const deleted = await this.system.purgeFinishedJobs(
        retentionDays,
        PURGE_BATCH,
      );
      total += deleted;
      if (deleted < PURGE_BATCH) break;
    }
    return total;
  }
}
