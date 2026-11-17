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
      () => void this.tick().catch((e) => this.logger.error(e.message)),
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
          // Кожне спрацювання — окремий ланцюжок, тож і власний кореляційний ID.
          await runWithCorrelationId(newCorrelationId(), 'cron', () =>
            this.executions.enqueue(wf, {}, 'cron'),
          );
          fired++;
        }
      } catch (err) {
        this.logger.warn(
          `workflow ${wf.id}: невалідний cron (${(err as Error).message})`,
        );
      }
    }
    this.lastTick = now;
    return fired;
  }
}
