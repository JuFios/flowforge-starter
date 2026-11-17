import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { EnvironmentVariables } from '../config/env.validation';
import { DataSource, Repository } from 'typeorm';
import {
  Execution,
  Job,
  StepRun,
  Workflow,
  WorkflowVersion,
} from '../entities';
import {
  getCorrelationId,
  newCorrelationId,
} from '../observability/correlation';

@Injectable()
export class ExecutionsService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @InjectRepository(Execution)
    private readonly executions: Repository<Execution>,
    @InjectRepository(StepRun) private readonly stepRuns: Repository<StepRun>,
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {}

  /**
   * Створює execution і job в одній транзакції; обидва несуть кореляційний ID поточного контексту.
   * Виконання прив'язується до версії workflow, поточної на момент створення (знімок кроків).
   */
  async enqueue(
    workflow: Workflow,
    input: Record<string, unknown>,
    trigger: Execution['trigger'],
  ): Promise<Execution> {
    const correlationId = getCorrelationId() ?? newCorrelationId();
    return this.ds.transaction(async (em) => {
      const version = await em.findOneOrFail(WorkflowVersion, {
        where: { workflowId: workflow.id, version: workflow.version },
        select: { id: true },
      });
      const execution = await em.save(
        em.create(Execution, {
          tenantId: workflow.tenantId,
          workflowId: workflow.id,
          workflowVersionId: version.id,
          input,
          trigger,
          correlationId,
        }),
      );
      await em.save(
        em.create(Job, {
          tenantId: workflow.tenantId,
          executionId: execution.id,
          maxAttempts: this.config.get('JOB_MAX_ATTEMPTS', { infer: true }),
          correlationId,
        }),
      );
      return execution;
    });
  }

  list(tenantId: string, limit = 50): Promise<Execution[]> {
    return this.executions.find({
      where: { tenantId },
      order: { createdAt: 'DESC' },
      take: Math.min(limit, 200),
    });
  }

  async get(id: string): Promise<Execution & { steps: StepRun[] }> {
    const execution = await this.executions.findOne({ where: { id } });
    if (!execution) throw new NotFoundException('Execution не знайдено');
    const steps = await this.stepRuns.find({
      where: { executionId: id },
      order: { stepIndex: 'ASC', startedAt: 'ASC' },
    });
    return { ...execution, steps };
  }
}
