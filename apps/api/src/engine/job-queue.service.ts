import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { EnvironmentVariables } from '../config/env.validation';
import { Job } from '../entities';

export function backoffMs(attempt: number): number {
  return Math.pow(2, attempt) * 1000;
}

/** Lease задачі вже забрано (прострочено й повернуто в чергу reaper-ом або захоплено іншим). */
export class LeaseLostError extends Error {
  constructor(jobId: string) {
    super(`lease on job ${jobId} is no longer held by this worker`);
  }
}

/** Задача, повернута reaper-ом після простроченого lease. */
export interface ReapedJob {
  id: string;
  executionId: string;
  correlationId: string | null;
  attempts: number;
  status: 'queued' | 'failed';
}

/** Скільки прострочених задач reaper обробляє за одну транзакцію. */
const REAP_BATCH = 100;

@Injectable()
export class JobQueueService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {}

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
  async claimNext(workerId: string): Promise<Job | null> {
    const [rows]: [Job[], number] = await this.ds.query(
      `UPDATE jobs
          SET status = 'running', "lockedBy" = $1, "lockToken" = gen_random_uuid(),
              "lockedUntil" = now() + make_interval(secs => $2),
              attempts = attempts + 1
        WHERE id = (
                SELECT id FROM jobs
                 WHERE status = 'queued' AND "runAt" <= now()
                 ORDER BY "runAt"
                 LIMIT 1
                 FOR UPDATE SKIP LOCKED
              )
        RETURNING *`,
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
   * (reaper і heartbeat чекатимуть). Кидає LeaseLostError — транзакцію буде відкочено.
   */
  async assertLease(em: EntityManager, job: Job): Promise<void> {
    const rows: unknown[] = await em.query(
      `SELECT id FROM jobs
        WHERE id = $1 AND "lockToken" = $2 AND status = 'running'
        FOR UPDATE`,
      [job.id, job.lockToken],
    );
    if (rows.length !== 1) throw new LeaseLostError(job.id);
  }

  async complete(job: Job): Promise<void> {
    await this.ds.transaction(async (em) => {
      await this.assertLease(em, job);
      await em.query(
        `UPDATE jobs SET status = 'done', "lockedBy" = NULL, "lockedUntil" = NULL, "lockToken" = NULL
          WHERE id = $1`,
        [job.id],
      );
    });
  }

  /** Повертає true, якщо задачу буде повторено, false — якщо вичерпано спроби. */
  async fail(job: Job, error: string, retryable: boolean): Promise<boolean> {
    return this.ds.transaction(async (em) => {
      await this.assertLease(em, job);
      if (retryable && job.attempts < job.maxAttempts) {
        await em.query(
          `UPDATE jobs
              SET status = 'queued', "lockedBy" = NULL, "lockedUntil" = NULL, "lockToken" = NULL,
                  "lastError" = $2, "runAt" = now() + make_interval(secs => $3)
            WHERE id = $1`,
          [job.id, error, backoffMs(job.attempts) / 1000],
        );
        return true;
      }
      await em.query(
        `UPDATE jobs
            SET status = 'failed', "lockedBy" = NULL, "lockedUntil" = NULL, "lockToken" = NULL,
                "lastError" = $2
          WHERE id = $1`,
        [job.id, error],
      );
      return false;
    });
  }

  /**
   * Повертає в чергу задачі, чий lease минув (воркер упав, завис або втратив зв'язок із БД).
   * Прострочений lease рахується як спроба: задача, що раз у раз валить воркер («отруйна»),
   * вичерпає спроби, а не крутитиметься вічно; повтор — із тим самим backoff, що й після помилки.
   * Рядки беруться через SKIP LOCKED: кілька reaper-ів і захоплення не заважають одне одному.
   */
  async reapExpired(): Promise<ReapedJob[]> {
    return this.ds.transaction(async (em) => {
      const expired: Job[] = await em.query(
        `SELECT * FROM jobs
          WHERE status = 'running' AND "lockedUntil" < now()
          ORDER BY "lockedUntil"
          LIMIT ${REAP_BATCH}
          FOR UPDATE SKIP LOCKED`,
      );
      const reaped: ReapedJob[] = [];
      for (const job of expired) {
        const error = `lease expired: worker ${job.lockedBy ?? '?'} stopped renewing it`;
        const retry = job.attempts < job.maxAttempts;
        if (retry) {
          await em.query(
            `UPDATE jobs
                SET status = 'queued', "lockedBy" = NULL, "lockedUntil" = NULL, "lockToken" = NULL,
                    "lastError" = $2, "runAt" = now() + make_interval(secs => $3)
              WHERE id = $1`,
            [job.id, error, backoffMs(job.attempts) / 1000],
          );
        } else {
          await em.query(
            `UPDATE jobs
                SET status = 'failed', "lockedBy" = NULL, "lockedUntil" = NULL, "lockToken" = NULL,
                    "lastError" = $2
              WHERE id = $1`,
            [job.id, error],
          );
          await em.query(
            `UPDATE executions SET status = 'failed', error = $2, "finishedAt" = now()
              WHERE id = $1`,
            [job.executionId, error],
          );
        }
        reaped.push({
          id: job.id,
          executionId: job.executionId,
          correlationId: job.correlationId,
          attempts: job.attempts,
          status: retry ? 'queued' : 'failed',
        });
      }
      return reaped;
    });
  }
}
