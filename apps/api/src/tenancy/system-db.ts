import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/** Розмір сторінки планувальника (`scheduled_workflows`); функція сама обмежує його 1000. */
export const SCHEDULE_PAGE = 500;

/**
 * Виклики SECURITY DEFINER-функцій — єдиний крос-тенантний доступ runtime-ролей (міграція
 * TenantIsolation). Функції віддають лише ідентифікатори й кількості, а не дані тенантів; самі рядки
 * застосунок читає вже через TenantDb, у контексті конкретного тенанта.
 */
@Injectable()
export class SystemDb {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  /** Тенант за sha256-хешем API-ключа або null. */
  async authTenant(apiKeyHash: string): Promise<string | null> {
    const [row]: Array<{ id: string | null }> = await this.ds.query(
      'SELECT auth_tenant($1) AS id',
      [apiKeyHash],
    );
    return row?.id ?? null;
  }

  /** Тенант увімкненого workflow (адресата webhook-а) або null. */
  async webhookTenant(workflowId: string): Promise<string | null> {
    const [row]: Array<{ id: string | null }> = await this.ds.query(
      'SELECT webhook_tenant($1) AS id',
      [workflowId],
    );
    return row?.id ?? null;
  }

  /** Сторінка workflow з розкладом після `after` (за id), до `limit` рядків. */
  scheduledWorkflows(
    after: string | null,
    limit = SCHEDULE_PAGE,
  ): Promise<Array<{ id: string; tenantId: string }>> {
    return this.ds.query('SELECT * FROM scheduled_workflows($1, $2)', [
      after,
      limit,
    ]);
  }

  /** Просуває дозрілих тенантів до індексу готових (пачка, SKIP LOCKED); кількість просунутих. */
  async promoteReadyTenants(batch: number): Promise<number> {
    const [row]: Array<{ promoted: number }> = await this.ds.query(
      'SELECT promote_ready_tenants($1) AS promoted',
      [batch],
    );
    return row.promoted;
  }

  /** Глибина черги кожного тенанта з незавершеними задачами (з обліку, без сканування задач). */
  queueDepthByTenant(): Promise<
    Array<{ tenantId: string; queued: number; running: number }>
  > {
    return this.ds.query('SELECT * FROM queue_depth_by_tenant()');
  }

  /** Тенанти з простроченими lease, крім `exclude` (уже оброблені в цьому проході). */
  async expiredLeaseTenants(
    exclude: string[],
    limit: number,
  ): Promise<string[]> {
    const rows: Array<{ id: string }> = await this.ds.query(
      'SELECT t AS id FROM expired_lease_tenants($1::uuid[], $2) AS t',
      [exclude, limit],
    );
    return rows.map((r) => r.id);
  }

  /**
   * Запит у фіксованому вікні ключа (`cost` 1) або лише стан вікна (`cost` 0): кількість запитів у
   * вікні й мілісекунди до його кінця — за годинником БД, спільним для всіх інстансів API.
   */
  async rateLimitHit(
    key: string,
    windowMs: number,
    cost: 0 | 1,
  ): Promise<{ hits: number; resetMs: number }> {
    const [row]: Array<{ hits: number; resetMs: number }> = await this.ds.query(
      'SELECT * FROM rate_limit_hit($1, $2, $3)',
      [key, windowMs, cost],
    );
    return row;
  }

  /** Одна пачка очищення відер частоти запитів, чиє вікно скінчилось; кількість видалених. */
  async purgeRateLimits(batch: number): Promise<number> {
    const [row]: Array<{ deleted: number }> = await this.ds.query(
      'SELECT purge_rate_limits($1) AS deleted',
      [batch],
    );
    return row.deleted;
  }

  /** Одна пачка очищення завершених задач; кількість видалених. */
  async purgeFinishedJobs(days: number, batch: number): Promise<number> {
    const [row]: Array<{ deleted: number }> = await this.ds.query(
      'SELECT purge_finished_jobs($1, $2) AS deleted',
      [days, batch],
    );
    return row.deleted;
  }

  /** Одна пачка очищення історії виконань; кількість видалених виконань. */
  async purgeExecutionHistory(days: number, batch: number): Promise<number> {
    const [row]: Array<{ deleted: number }> = await this.ds.query(
      'SELECT purge_execution_history($1, $2) AS deleted',
      [days, batch],
    );
    return row.deleted;
  }
}
