import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Job } from '../entities';
import { EffectiveLimits } from './limits';

/** Найдовше читання глибини черги для метрик, мс (або менше — за statement_timeout сесії). */
const QUEUE_DEPTH_TIMEOUT_MS = 2_000;

/** Розмір сторінки планувальника (`due_schedule_tenants`); функція сама обмежує його 1000. */
export const SCHEDULE_PAGE = 500;

/**
 * Виклики SECURITY DEFINER-функцій — єдиний крос-тенантний доступ runtime-ролей (міграція
 * TenantIsolation). Функції віддають лише ідентифікатори й кількості, а не дані тенантів; самі рядки
 * застосунок читає вже через TenantDb, у контексті конкретного тенанта.
 */
@Injectable()
export class SystemDb {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  /**
   * Чинна браузерна сесія за sha256-хешем токена разом з ефективними лімітами її тенанта
   * (`auth_session`) або undefined.
   */
  async authSession(
    hash: Buffer,
  ): Promise<
    | ({ id: string; tenantId: string; expiresAt: Date } & EffectiveLimits)
    | undefined
  > {
    const [row] = await this.ds.query<
      Array<{ id: string; tenantId: string; expiresAt: Date } & EffectiveLimits>
    >('SELECT * FROM auth_session($1)', [hash]);
    return row;
  }

  async redeemTicket(hash: Buffer) {
    const [row] = await this.ds.query<
      Array<{
        tenantId: string;
        executionId: string;
        sessionId: string | null;
        sessionExpiresAt: Date | null;
      }>
    >('SELECT * FROM redeem_realtime_ticket($1)', [hash]);
    return row;
  }

  /**
   * Тенант за sha256-хешем API-ключа разом з його ефективними лімітами (`auth_tenant`) або null.
   */
  async authTenant(
    apiKeyHash: string,
  ): Promise<({ id: string } & EffectiveLimits) | null> {
    const [row]: Array<{ id: string } & EffectiveLimits> = await this.ds.query(
      'SELECT * FROM auth_tenant($1)',
      [apiKeyHash],
    );
    return row ?? null;
  }

  /**
   * Тенант workflow — адресата webhook-а, увімкненого чи ні (повтор прийнятої доставки), або null.
   */
  async webhookTenant(workflowId: string): Promise<string | null> {
    const [row]: Array<{ id: string | null }> = await this.ds.query(
      'SELECT webhook_tenant($1) AS id',
      [workflowId],
    );
    return row?.id ?? null;
  }

  /**
   * Сторінка тенантів, у яких є належний розклад (`nextFireAt` настав), після `after` (за id), до
   * `limit` рядків. Лише ідентифікатори: самі розклади планувальник читає в контексті тенанта.
   */
  dueScheduleTenants(
    after: string | null,
    limit = SCHEDULE_PAGE,
  ): Promise<Array<{ tenantId: string }>> {
    return this.ds.query('SELECT * FROM due_schedule_tenants($1, $2)', [
      after,
      limit,
    ]);
  }

  /**
   * Справедливе захоплення однієї задачі (`claim_job`, README, 3.3.5): задача (або null), скільки
   * рядків обліку перераховано, і чи були всі кандидати зайняті іншими захопленнями.
   */
  async claimJob(
    workerId: string,
    leaseMs: number,
  ): Promise<{
    job: (Job & { claimedAt: Date }) | null;
    repaired: number;
    busy: boolean;
  }> {
    const [row]: Array<
      Job & { claimedAt: Date | null; repaired: number; busy: boolean }
    > = await this.ds.query(
      `SELECT (r.job).*, r."claimedAt", r.repaired, r.busy FROM claim_job($1, $2) r`,
      [workerId, leaseMs],
    );
    const { repaired, busy, ...job } = row;
    return {
      job: job.id ? (job as Job & { claimedAt: Date }) : null,
      repaired,
      busy,
    };
  }

  /**
   * Глибина черги кожного тенанта з незавершеними задачами (з обліку, без сканування задач). Межа
   * часу — менша з QUEUE_DEPTH_TIMEOUT_MS і statement_timeout сесії (0 — без межі): скрейп метрик не
   * чекає на БД довше, а коротший DB_STATEMENT_TIMEOUT_MS діє й тут (сервер скасовує запит раніше за
   * клієнтський query_timeout).
   */
  queueDepthByTenant(): Promise<
    Array<{ tenantId: string; queued: number; running: number }>
  > {
    return this.ds.transaction(async (em) => {
      await em.query(
        `SELECT pg_catalog.set_config('statement_timeout',
                  (CASE WHEN s.setting::int = 0 THEN $1 ELSE least(s.setting::int, $1) END)::text, true)
           FROM pg_catalog.pg_settings s WHERE s.name = 'statement_timeout'`,
        [QUEUE_DEPTH_TIMEOUT_MS],
      );
      return em.query<
        Array<{ tenantId: string; queued: number; running: number }>
      >('SELECT * FROM queue_depth_by_tenant()');
    });
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
  async purgeBrowserCredentials(batch: number): Promise<number> {
    const [row] = await this.ds.query<Array<{ deleted: number }>>(
      'SELECT purge_browser_credentials($1) AS deleted',
      [batch],
    );
    return row.deleted;
  }

  async purgeRateLimits(batch: number): Promise<number> {
    const [row]: Array<{ deleted: number }> = await this.ds.query(
      'SELECT purge_rate_limits($1) AS deleted',
      [batch],
    );
    return row.deleted;
  }

  /**
   * Справедливе захоплення спроби доставки сповіщення (`claim_outbox_event`, README 3.3.9):
   * подія (лише ідентифікатори й fencing-токен) або null, і скільки підказок `dueAt` перераховано.
   */
  async claimOutboxEvent(
    senderId: string,
    leaseMs: number,
    inFlight: number,
  ): Promise<{
    event: {
      id: string;
      tenantId: string;
      leaseToken: string;
      attempt: number;
      correlationId: string | null;
    } | null;
    repaired: number;
  }> {
    const [row]: Array<{
      id: string | null;
      tenantId: string;
      leaseToken: string;
      attempt: number;
      correlationId: string | null;
      repaired: number;
    }> = await this.ds.query('SELECT * FROM claim_outbox_event($1, $2, $3)', [
      senderId,
      leaseMs,
      inFlight,
    ]);
    const { repaired, ...event } = row;
    return {
      event: event.id ? { ...event, id: event.id } : null,
      repaired,
    };
  }

  /** Одна пачка очищення доставлених подій; кількість видалених. */
  async purgeDeliveredEvents(days: number, batch: number): Promise<number> {
    const [row]: Array<{ deleted: number }> = await this.ds.query(
      'SELECT purge_delivered_events($1, $2) AS deleted',
      [days, batch],
    );
    return row.deleted;
  }

  /** Недоставлені події за тенантом (кількості й найстаріша), з межею часу як у глибини черги. */
  outboxBacklog(): Promise<
    Array<{
      tenantId: string;
      pending: number;
      sending: number;
      oldest: Date;
    }>
  > {
    return this.ds.transaction(async (em) => {
      await em.query(
        `SELECT pg_catalog.set_config('statement_timeout',
                  (CASE WHEN s.setting::int = 0 THEN $1 ELSE least(s.setting::int, $1) END)::text, true)
           FROM pg_catalog.pg_settings s WHERE s.name = 'statement_timeout'`,
        [QUEUE_DEPTH_TIMEOUT_MS],
      );
      return em.query<
        Array<{
          tenantId: string;
          pending: number;
          sending: number;
          oldest: Date;
        }>
      >('SELECT * FROM outbox_backlog()');
    });
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

  /**
   * Одна сторінка проходу очищення версій. Новий прохід починається не раніше ніж через
   * `minGapMs` після завершення попереднього (будь-яким воркером); до того — `(0, false)`.
   */
  async purgeWorkflowVersions(
    minGapMs = 0,
  ): Promise<{ deleted: number; more: boolean }> {
    const [row]: Array<{ deleted: number; more: boolean }> =
      await this.ds.query('SELECT * FROM purge_workflow_versions($1)', [
        minGapMs,
      ]);
    return row;
  }
}
