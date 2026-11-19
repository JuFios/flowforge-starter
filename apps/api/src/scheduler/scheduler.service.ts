import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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

@Injectable()
export class SchedulerService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(SchedulerService.name);
  private timer?: NodeJS.Timeout;
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
  async tick(now = new Date()): Promise<number> {
    const scheduled = await this.scheduledWorkflows();

    let fired = 0;
    for (const wf of scheduled) {
      try {
        const it = parseExpression(wf.cron as string, {
          currentDate: this.lastTick,
        });
        for (
          let next = it.next().toDate();
          next <= now;
          next = it.next().toDate()
        ) {
          // Як і раніше: після невдалого спрацювання решту спрацювань цього workflow
          // у цьому тіку не створюємо.
          if (!(await this.fire(wf, next))) break;
          fired++;
        }
      } catch (err) {
        this.logger.warn(
          { workflowId: wf.id, error: toSafeError(err) },
          'cron schedule could not be evaluated',
        );
      }
    }
    this.lastTick = now;
    return fired;
  }

  /**
   * Усі увімкнені workflow з розкладом: ідентифікатори — сторінками SECURITY DEFINER-функції
   * `scheduled_workflows` (keyset за id, до кінця), самі workflow — у контексті свого тенанта.
   */
  private async scheduledWorkflows(): Promise<Workflow[]> {
    const result: Workflow[] = [];
    let after: string | null = null;
    for (;;) {
      const page = await this.system.scheduledWorkflows(after, SCHEDULE_PAGE);
      for (const { id, tenantId } of page) {
        const wf = await this.db.run(tenantId, (em) =>
          em.findOne(Workflow, {
            where: { id, tenantId, enabled: true },
          }),
        );
        if (wf?.cron) result.push(wf);
      }
      // Неповна сторінка — остання.
      if (page.length < SCHEDULE_PAGE) break;
      after = page[page.length - 1].id;
    }
    return result;
  }

  /**
   * Одне спрацювання — окремий ланцюжок із власним кореляційним ID. Помилка логується
   * всередині цього контексту, з workflowId і запланованим часом.
   */
  private fire(wf: Workflow, scheduledAt: Date): Promise<boolean> {
    return runWithCorrelationId(newCorrelationId(), 'cron', async () => {
      try {
        await this.executions.enqueue(wf, {}, 'cron');
        return true;
      } catch (err) {
        // Черга тенанта заповнена: спрацювання пропускається (метрика відхилених постановок —
        // flowforge_enqueue_rejected_total{trigger="cron"}), розклад іде далі.
        if (err instanceof QueueFullException) {
          this.logger.warn(
            { workflowId: wf.id, scheduledAt: scheduledAt.toISOString() },
            'scheduled run skipped: the tenant queue is full',
          );
          return false;
        }
        this.logger.warn(
          {
            workflowId: wf.id,
            scheduledAt: scheduledAt.toISOString(),
            error: toSafeError(err),
          },
          'scheduled run not created',
        );
        return false;
      }
    });
  }
}
