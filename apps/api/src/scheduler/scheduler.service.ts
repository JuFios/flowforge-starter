import {
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EntityManager } from 'typeorm';
import { EnvironmentVariables } from '../config/env.validation';
import { MissedRunPolicy, Workflow } from '../entities';
import { ExecutionsService } from '../executions/executions.service';
import { QueueFullException } from '../limits/limit-exceptions';
import { runWithCorrelationId } from '../observability/correlation';
import { toSafeError } from '../observability/safe-error';
import { SCHEDULE_PAGE, SystemDb } from '../tenancy/system-db';
import { TenantDb } from '../tenancy/tenant-db';
import { CronSchedule, InvalidScheduleError } from './cron-schedule';
import { SchedulerMetrics } from './scheduler.metrics';

const WORKFLOW_PAGE = 16;

/**
 * Спроб спрацювання одного тенанта за раунд обходу. Рахуються моменти, а не workflow: інакше 16
 * секундних розкладів одного тенанта після простою давали б тисячі постановок поспіль.
 */
const TENANT_ROUND_BUDGET = 16;

/** Де продовжити обхід тенанта в наступному раунді (лише ідентифікатор workflow). */
interface Cursor {
  tenantId: string;
  from?: { id: string; inclusive: boolean };
}

/** Результат однієї спроби спрацювання workflow. */
type Attempt =
  /** Моменту ще не настав, рядок зайнятий іншим інстансом або розклад вимкнено. */
  | 'idle'
  /** Створено виконання (або воно вже було) — момент оброблено, курсор пересунуто. */
  | 'fired'
  /** Пропущені моменти відкинуто за політикою `skip`. */
  | 'skipped'
  /** Черга тенанта повна: курсор стоїть, наступний тік спробує знову. */
  | 'blocked'
  /** Розклад не обчислюється (успадкований невалідний вираз). */
  | 'invalid';

/** Рядок workflow, заблокований спрацюванням, разом із часом БД. */
interface LockedSchedule {
  id: string;
  tenantId: string;
  cron: string;
  timezone: string;
  version: number;
  missedRunPolicy: MissedRunPolicy;
  scheduleCursor: Date;
  nextFireAt: Date | null;
  scheduleBlockedSince: Date | null;
  scheduleError: string | null;
  now: Date;
}

/** Коди помилок з'єднання драйвера й мережі: БД недоступна для всіх розкладів, а не для одного. */
const CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

/**
 * Помилка обробки одного workflow (будь-яка, крім недоступної БД): обробка інших розкладів триває,
 * а цей повторить наступний тік. Недоступна БД (з'єднання, сервер завершується, бракує ресурсів)
 * перериває тік: інакше кожен розклад чекав би свій таймаут підключення.
 */
function scopedToWorkflow(err: unknown): boolean {
  const e = err as {
    driverError?: { code?: unknown };
    code?: unknown;
    message?: unknown;
  };
  const code = e?.driverError?.code ?? e?.code;
  if (typeof code === 'string') {
    if (CONNECTION_CODES.has(code)) return false;
    if (/^(08|53|57P)/.test(code)) return false;
  }
  const message = typeof e?.message === 'string' ? e.message : '';
  return !/Connection terminated|timeout exceeded when trying to connect|connect ECONNREFUSED/.test(
    message,
  );
}

/** Кореляційний ID спрацювання: однаковий для кожної спроби того самого моменту. */
export function cronCorrelationId(workflowId: string, at: Date): string {
  return `cron:${workflowId}:${at.getTime()}`;
}

/**
 * Розподілений планувальник (README 3.3.8). Джерело істини — курсор у рядку workflow: усі моменти
 * розкладу до нього включно оброблено. Кожне спрацювання — окрема коротка транзакція: блокування
 * рядка workflow (SKIP LOCKED: зайнятий рядок уже обробляє інший інстанс), виконання й задача,
 * новий курсор. Курсор і виконання з'являються разом або ніяк, тож рестарт, кілька інстансів,
 * помилка БД чи невідомий результат COMMIT не дають ні дубля, ні втрати.
 */
@Injectable()
export class SchedulerService
  implements
    OnApplicationBootstrap,
    BeforeApplicationShutdown,
    OnApplicationShutdown
{
  private readonly logger = new Logger(SchedulerService.name);
  private timer?: NodeJS.Timeout;
  private activeTick?: Promise<number>;
  /** Процес завершується: тік, що триває, зупиняється після поточного спрацювання. */
  private stopping = false;
  /** Помилки, уже залоговані в контексті спрацювання (щоб не логувати вдруге без нього). */
  private readonly logged = new WeakSet<object>();

  constructor(
    private readonly system: SystemDb,
    private readonly db: TenantDb,
    private readonly executions: ExecutionsService,
    private readonly config: ConfigService<EnvironmentVariables, true>,
    private readonly metrics: SchedulerMetrics,
  ) {}

  onApplicationBootstrap(): void {
    const every = this.config.get('SCHEDULER_TICK_MS', { infer: true });
    this.timer = setInterval(
      () =>
        void this.tick().catch((err: unknown) =>
          this.logger.error(
            { error: toSafeError(err) },
            'scheduler tick failed',
          ),
        ),
      every,
    );
  }

  /** Зупиняє тіки; викликається й тестами, що самі вирішують, коли настає тік. */
  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Завершення процесу: нових тіків немає, а поточний дописує свою транзакцію до закриття пулу. */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    this.onApplicationShutdown();
    await this.activeTick?.catch(() => undefined);
  }

  /** Обробляє всі належні моменти розкладів; повертає кількість створених виконань. */
  tick(): Promise<number> {
    this.activeTick ??= this.runTick().finally(() => {
      this.activeTick = undefined;
    });
    return this.activeTick;
  }

  /**
   * Обхід раундами (README 3.3.5, 3.3.8): у раунді кожен тенант із належними розкладами робить
   * до TENANT_ROUND_BUDGET спроб, потім хід переходить до наступного. Між раундами зберігається
   * лише курсор обходу тенанта; моменти розкладу щоразу обчислюються з курсора в БД, тож пам'ять не
   * залежить від тривалості простою.
   */
  private async runTick(): Promise<number> {
    const stop = this.metrics.tickDuration.startTimer();
    let fired = 0;
    try {
      const remaining = new Map<string, Cursor>();
      const turn = async (cursor: Cursor) => {
        const result = await this.tenantTurn(cursor);
        fired += result.fired;
        if (result.next) remaining.set(cursor.tenantId, result.next);
      };
      let after: string | null = null;
      for (;;) {
        const tenants = await this.system.dueScheduleTenants(
          after,
          SCHEDULE_PAGE,
        );
        for (const { tenantId } of tenants) {
          if (this.stopping) return fired;
          await turn({ tenantId });
        }
        if (tenants.length < SCHEDULE_PAGE) break;
        after = tenants[tenants.length - 1].tenantId;
      }
      // Ітератор Map відвідує повторно доданий ключ у кінці черги.
      for (const [tenantId, cursor] of remaining) {
        if (this.stopping) return fired;
        remaining.delete(tenantId);
        await turn(cursor);
      }
      return fired;
    } finally {
      stop();
    }
  }

  /** Один хід тенанта: належні workflow від курсора і до TENANT_ROUND_BUDGET спроб. */
  private async tenantTurn(
    cursor: Cursor,
  ): Promise<{ fired: number; next?: Cursor }> {
    const { tenantId, from } = cursor;
    const params: unknown[] = [tenantId, WORKFLOW_PAGE];
    let where = '';
    if (from) {
      params.push(from.id);
      where = from.inclusive ? 'AND id >= $3' : 'AND id > $3';
    }
    const rows: Array<{ id: string }> = await this.db.run(tenantId, (em) =>
      em.query(
        `SELECT id FROM workflows
          WHERE "tenantId" = $1 AND enabled AND cron IS NOT NULL AND "nextFireAt" <= now() ${where}
          ORDER BY id LIMIT $2`,
        params,
      ),
    );
    let fired = 0;
    let budget = TENANT_ROUND_BUDGET;
    for (const { id } of rows) {
      for (;;) {
        if (this.stopping) return { fired };
        if (budget === 0)
          return {
            fired,
            next: { tenantId, from: { id, inclusive: true } },
          };
        let result: { attempt: Attempt; created: boolean };
        try {
          result = await this.fireNext(tenantId, id);
        } catch (err) {
          if (!scopedToWorkflow(err)) throw err;
          this.metrics.errors.inc({ reason: 'database' });
          if (!this.logged.has(err as object))
            this.logger.warn(
              { workflowId: id, error: toSafeError(err) },
              'scheduled run not created, the next tick retries it',
            );
          break;
        }
        if (result.created) fired++;
        // Повна черга: інші розклади тенанта впираються в ту саму чергу, до наступного тіку.
        if (result.attempt === 'blocked') return { fired };
        if (result.attempt !== 'fired' && result.attempt !== 'skipped') break;
        budget--;
      }
    }
    if (rows.length < WORKFLOW_PAGE) return { fired };
    return {
      fired,
      next: {
        tenantId,
        from: { id: rows[rows.length - 1].id, inclusive: false },
      },
    };
  }

  /**
   * Наступний належний момент одного workflow — одна транзакція в контексті тенанта. Повна черга
   * відкочує її (курсор стоїть), і окрема коротка транзакція позначає, що розклад чекає на місце.
   */
  private async fireNext(
    tenantId: string,
    workflowId: string,
  ): Promise<{ attempt: Attempt; created: boolean }> {
    try {
      return await this.db.run(tenantId, (em) =>
        this.fireIn(em, tenantId, workflowId),
      );
    } catch (err) {
      if (!(err instanceof QueueFullException)) throw err;
      this.metrics.blocked.inc({ reason: 'queue_full' });
      const [rows]: [Array<{ id: string }>, number] = await this.db.run(
        tenantId,
        (em) =>
          em.query(
            `UPDATE workflows SET "scheduleBlockedSince" = now()
              WHERE id = $1 AND "tenantId" = $2 AND "scheduleBlockedSince" IS NULL
              RETURNING id`,
            [workflowId, tenantId],
          ),
      );
      if (rows.length > 0)
        this.logger.warn(
          { workflowId },
          'scheduled runs are held: the tenant queue is full',
        );
      return { attempt: 'blocked', created: false };
    }
  }

  private async fireIn(
    em: EntityManager,
    tenantId: string,
    workflowId: string,
  ): Promise<{ attempt: Attempt; created: boolean }> {
    const [row]: LockedSchedule[] = await em.query(
      `SELECT id, "tenantId", cron, timezone, version, "missedRunPolicy", "scheduleCursor",
              "nextFireAt", "scheduleBlockedSince", "scheduleError", clock_timestamp() AS now
         FROM workflows
        WHERE id = $1 AND "tenantId" = $2 AND enabled AND cron IS NOT NULL
        FOR NO KEY UPDATE SKIP LOCKED`,
      [workflowId, tenantId],
    );
    if (!row) return { attempt: 'idle', created: false };
    let schedule: CronSchedule;
    let next: Date;
    try {
      schedule = CronSchedule.parse(row.cron, row.timezone, row.now.getTime());
      next = schedule.next(row.scheduleCursor);
    } catch (err) {
      if (!(err instanceof InvalidScheduleError)) throw err;
      await this.markInvalid(em, row, err.message);
      return { attempt: 'invalid', created: false };
    }
    if (next > row.now) {
      await this.save(em, row, row.scheduleCursor, next);
      return { attempt: 'idle', created: false };
    }
    const grace = this.config.get('SCHEDULER_MISFIRE_GRACE_MS', {
      infer: true,
    });
    const threshold = new Date(row.now.getTime() - grace);
    let at = next;
    let cursor = next;
    if (next < threshold) {
      if (row.missedRunPolicy === 'skip') {
        this.metrics.firings.inc({ outcome: 'missed_skipped' });
        this.logger.warn(
          {
            workflowId,
            firstSkipped: next.toISOString(),
            skippedUntil: threshold.toISOString(),
          },
          'missed scheduled runs skipped by the workflow policy',
        );
        await this.save(em, row, threshold, schedule);
        return { attempt: 'skipped', created: false };
      }
      if (row.missedRunPolicy === 'run_once') {
        // Один запуск за весь пропуск — за останнім пропущеним моментом.
        at = schedule.lastAtOrBefore(threshold, row.scheduleCursor) ?? next;
        cursor = threshold;
        this.metrics.firings.inc({ outcome: 'missed_run_once' });
        this.logger.warn(
          {
            workflowId,
            firstMissed: next.toISOString(),
            runAt: at.toISOString(),
          },
          'missed scheduled runs collapsed into one run by the workflow policy',
        );
      }
      // run_all: кожен пропущений момент — окреме виконання, у порядку розкладу.
    }
    const workflow = em.create(Workflow, {
      id: row.id,
      tenantId: row.tenantId,
      version: row.version,
    });
    const correlationId = cronCorrelationId(workflowId, at);
    const created = await runWithCorrelationId(
      correlationId,
      'cron',
      async () => {
        try {
          return await this.executions.enqueueScheduledIn(
            em,
            workflow,
            at,
            correlationId,
          );
        } catch (err) {
          // У контексті спрацювання (кореляційний ID моменту), з workflowId і моментом. Помилка
          // з'єднання перериває тік, і її логує сам тік.
          if (scopedToWorkflow(err)) {
            this.logged.add(err as object);
            this.logger.warn(
              {
                workflowId,
                scheduledAt: at.toISOString(),
                error: toSafeError(err),
              },
              'scheduled run not created, the next tick retries it',
            );
          }
          throw err;
        }
      },
    );
    await this.save(em, row, cursor, schedule);
    this.metrics.firings.inc({ outcome: created ? 'created' : 'existing' });
    if (created)
      this.metrics.lag.observe(
        Math.max(0, row.now.getTime() - at.getTime()) / 1000,
      );
    return { attempt: 'fired', created };
  }

  /**
   * Підказка наступного моменту після курсора або null, якщо в межах горизонту генератора моментів
   * більше немає: уже оброблене спрацювання через це не відкочується, а тік до розкладу не повертається.
   */
  private following(schedule: CronSchedule, cursor: Date): Date | null {
    try {
      return schedule.next(cursor);
    } catch (err) {
      if (err instanceof InvalidScheduleError) return null;
      throw err;
    }
  }

  /** Новий курсор і підказка наступного моменту; знімає позначки «чекає» і «невалідний». */
  private async save(
    em: EntityManager,
    row: LockedSchedule,
    cursor: Date,
    next: Date | CronSchedule,
  ): Promise<void> {
    const nextFireAt =
      next instanceof CronSchedule ? this.following(next, cursor) : next;
    const unchanged =
      cursor.getTime() === row.scheduleCursor.getTime() &&
      (row.nextFireAt?.getTime() ?? null) === (nextFireAt?.getTime() ?? null) &&
      row.scheduleBlockedSince === null &&
      row.scheduleError === null;
    if (unchanged) return;
    await em.query(
      `UPDATE workflows SET "scheduleCursor" = $3, "nextFireAt" = $4,
              "scheduleBlockedSince" = NULL, "scheduleError" = NULL
        WHERE id = $1 AND "tenantId" = $2`,
      [row.id, row.tenantId, cursor, nextFireAt],
    );
    if (row.scheduleBlockedSince !== null)
      this.logger.log(
        {
          workflowId: row.id,
          heldSince: row.scheduleBlockedSince.toISOString(),
        },
        'scheduled runs resumed: the tenant queue has room again',
      );
  }

  /**
   * Розклад не обчислюється: курсор стоїть, підказка знята (тік не повертається до нього, доки
   * тенант не змінить розклад), причина видна в workflow. Лог — лише при зміні причини.
   */
  private async markInvalid(
    em: EntityManager,
    row: LockedSchedule,
    reason: string,
  ): Promise<void> {
    this.metrics.errors.inc({ reason: 'invalid_schedule' });
    await em.query(
      `UPDATE workflows SET "nextFireAt" = NULL, "scheduleError" = $3
        WHERE id = $1 AND "tenantId" = $2`,
      [row.id, row.tenantId, reason],
    );
    if (row.scheduleError !== reason)
      this.logger.warn(
        { workflowId: row.id, reason },
        'cron schedule could not be evaluated',
      );
  }
}
