import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Job } from '../entities';

const LEASE_SECONDS = 60;

export function backoffMs(attempt: number): number {
  return Math.pow(2, attempt) * 1000;
}

@Injectable()
export class JobQueueService {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  /**
   * Атомарно захоплює наступну готову задачу, або повертає null.
   *
   * Вибір і захоплення — один оператор: `FOR UPDATE SKIP LOCKED` блокує вибраний рядок до кінця
   * оператора, а конкурентні воркери пропускають заблоковані рядки й беруть наступні, тож одну
   * задачу не може отримати двоє. `RETURNING *` повертає вже оновлений рядок.
   */
  async claimNext(workerId: string): Promise<Job | null> {
    const [rows]: [Job[], number] = await this.ds.query(
      `UPDATE jobs
          SET status = 'running', "lockedBy" = $1,
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
      [workerId, LEASE_SECONDS],
    );
    return rows[0] ?? null;
  }

  async complete(jobId: string): Promise<void> {
    await this.ds.query(
      `UPDATE jobs SET status = 'done', "lockedBy" = NULL, "lockedUntil" = NULL WHERE id = $1`,
      [jobId],
    );
  }

  /** Повертає true, якщо задачу буде повторено, false — якщо вичерпано спроби. */
  async fail(job: Job, error: string, retryable: boolean): Promise<boolean> {
    if (retryable && job.attempts < job.maxAttempts) {
      await this.ds.query(
        `UPDATE jobs
            SET status = 'queued', "lockedBy" = NULL, "lockedUntil" = NULL, "lastError" = $2,
                "runAt" = now() + make_interval(secs => $3)
          WHERE id = $1`,
        [job.id, error, backoffMs(job.attempts) / 1000],
      );
      return true;
    }
    await this.ds.query(
      `UPDATE jobs SET status = 'failed', "lockedBy" = NULL, "lockedUntil" = NULL, "lastError" = $2 WHERE id = $1`,
      [job.id, error],
    );
    return false;
  }
}
