import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { parseExpression } from 'cron-parser';
import { Repository } from 'typeorm';
import { EnvironmentVariables } from '../config/env.validation';
import { Workflow } from '../entities';
import { ExecutionsService } from '../executions/executions.service';
import {
  newCorrelationId,
  runWithCorrelationId,
} from '../observability/correlation';
import { toSafeError } from '../observability/safe-error';

@Injectable()
export class SchedulerService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(SchedulerService.name);
  private timer?: NodeJS.Timeout;
  private lastTick = new Date();

  constructor(
    @InjectRepository(Workflow)
    private readonly workflows: Repository<Workflow>,
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
    const scheduled = await this.workflows
      .createQueryBuilder('w')
      .where('w.enabled = true AND w.cron IS NOT NULL')
      .getMany();

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
   * Одне спрацювання — окремий ланцюжок із власним кореляційним ID. Помилка логується
   * всередині цього контексту, з workflowId і запланованим часом.
   */
  private fire(wf: Workflow, scheduledAt: Date): Promise<boolean> {
    return runWithCorrelationId(newCorrelationId(), 'cron', async () => {
      try {
        await this.executions.enqueue(wf, {}, 'cron');
        return true;
      } catch (err) {
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
