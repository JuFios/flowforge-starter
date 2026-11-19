import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsNull, MoreThan, MoreThanOrEqual, Not } from 'typeorm';
import { parseExpression } from 'cron-parser';
import { EnvironmentVariables } from '../config/env.validation';
import { Workflow } from '../entities';
import { ExecutionsService } from '../executions/executions.service';
import { QueueFullException } from '../limits/limit-exceptions';
import {
  newCorrelationId,
  runWithCorrelationId,
} from '../observability/correlation';
import { toSafeError } from '../observability/safe-error';
import { SCHEDULE_PAGE, SystemDb } from '../tenancy/system-db';
import { TenantDb } from '../tenancy/tenant-db';

const WORKFLOW_PAGE = 16;

/**
 * Спроб постановки одного тенанта за раунд обходу. Рахуються спроби, а не workflow: інакше 16
 * секундних розкладів одного тенанта за 30-секундний тік давали б 480 постановок поспіль.
 */
const TENANT_ROUND_BUDGET = 16;

/** Де продовжити обхід тенанта в наступному раунді (лише ідентифікатори й момент). */
interface Cursor {
  tenantId: string;
  from?: { id: string; inclusive: boolean };
  /** Останнє вже спробуване спрацювання workflow, на якому скінчився бюджет. */
  resume?: { workflowId: string; after: Date };
}

@Injectable()
export class SchedulerService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(SchedulerService.name);
  private timer?: NodeJS.Timeout;
  private activeTick?: Promise<number>;
  private lastTick = new Date();

  constructor(
    private readonly system: SystemDb,
    private readonly db: TenantDb,
    private readonly executions: ExecutionsService,
    private readonly config: ConfigService<EnvironmentVariables, true>,
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

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Створює execution для кожного cron-спрацювання з моменту попереднього тіку. */
  tick(now = new Date()): Promise<number> {
    this.activeTick ??= this.runTick(now).finally(() => {
      this.activeTick = undefined;
    });
    return this.activeTick;
  }

  /**
   * Обхід раундами: у раунді кожен тенант робить до TENANT_ROUND_BUDGET спроб постановки, потім
   * хід переходить до наступного. Тенант із невичерпаними спрацюваннями стає в кінець черги; між
   * раундами зберігається лише його курсор, а сторінка workflow перечитується (вимкнений чи змінений
   * розклад враховується з наступного раунду тенанта).
   */
  private async runTick(now: Date): Promise<number> {
    let fired = 0;
    const remaining = new Map<string, Cursor>();
    const turn = async (cursor: Cursor) => {
      const result = await this.tenantTurn(cursor, now);
      fired += result.fired;
      if (result.next) remaining.set(cursor.tenantId, result.next);
    };
    let after: string | null = null;
    for (;;) {
      const tenants = await this.system.scheduledTenants(after, SCHEDULE_PAGE);
      for (const { tenantId } of tenants) await turn({ tenantId });
      if (tenants.length < SCHEDULE_PAGE) break;
      after = tenants[tenants.length - 1].tenantId;
    }
    // Ітератор Map відвідує повторно доданий ключ у кінці черги.
    for (const [tenantId, cursor] of remaining) {
      remaining.delete(tenantId);
      await turn(cursor);
    }
    this.lastTick = now;
    return fired;
  }

  /** Один хід тенанта: сторінка workflow від курсора і до TENANT_ROUND_BUDGET спроб постановки. */
  private async tenantTurn(
    cursor: Cursor,
    now: Date,
  ): Promise<{ fired: number; next?: Cursor }> {
    const { tenantId, from, resume } = cursor;
    const rows = await this.db.run(tenantId, (em) =>
      em.find(Workflow, {
        select: { id: true, tenantId: true, cron: true, version: true },
        where: {
          tenantId,
          enabled: true,
          cron: Not(IsNull()),
          ...(from && {
            id: from.inclusive ? MoreThanOrEqual(from.id) : MoreThan(from.id),
          }),
        },
        order: { id: 'ASC' },
        take: WORKFLOW_PAGE,
      }),
    );
    let fired = 0;
    let budget = TENANT_ROUND_BUDGET;
    for (const wf of rows) {
      // Продовження workflow, на якому скінчився бюджет попереднього раунду, — після вже спробуваного.
      let last = resume?.workflowId === wf.id ? resume.after : undefined;
      try {
        const it = parseExpression(wf.cron as string, {
          currentDate: last ?? this.lastTick,
        });
        for (
          let next = it.next().toDate();
          next <= now;
          next = it.next().toDate()
        ) {
          if (budget === 0)
            return {
              fired,
              next: {
                tenantId,
                from: { id: wf.id, inclusive: true },
                resume: last && { workflowId: wf.id, after: last },
              },
            };
          budget--;
          // Як і раніше: після невдалого спрацювання решту спрацювань цього workflow
          // у цьому тіку не створюємо.
          const created = await this.fire(wf, next);
          if (created === undefined) break;
          if (created) fired++;
          last = next;
        }
      } catch (err) {
        this.logger.warn(
          { workflowId: wf.id, error: toSafeError(err) },
          'cron schedule could not be evaluated',
        );
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
   * Одне спрацювання — окремий ланцюжок із власним кореляційним ID. Помилка логується
   * всередині цього контексту, з workflowId і запланованим часом.
   */
  private fire(wf: Workflow, scheduledAt: Date): Promise<boolean | undefined> {
    return runWithCorrelationId(newCorrelationId(), 'cron', async () => {
      try {
        return await this.executions.enqueueScheduled(wf, scheduledAt);
      } catch (err) {
        // Черга тенанта заповнена: спрацювання пропускається (метрика відхилених постановок —
        // flowforge_enqueue_rejected_total{trigger="cron"}), розклад іде далі.
        if (err instanceof QueueFullException) {
          this.logger.warn(
            { workflowId: wf.id, scheduledAt: scheduledAt.toISOString() },
            'scheduled run skipped: the tenant queue is full',
          );
          return undefined;
        }
        this.logger.warn(
          {
            workflowId: wf.id,
            scheduledAt: scheduledAt.toISOString(),
            error: toSafeError(err),
          },
          'scheduled run not created',
        );
        return undefined;
      }
    });
  }
}
