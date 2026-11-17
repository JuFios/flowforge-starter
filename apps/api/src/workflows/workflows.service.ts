import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { Workflow, WorkflowVersion } from '../entities';
import { validateSteps } from './definition';

export interface WorkflowInput {
  name: string;
  steps: unknown;
  cron?: string | null;
  timezone?: string;
  enabled?: boolean;
}

@Injectable()
export class WorkflowsService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @InjectRepository(Workflow)
    private readonly workflows: Repository<Workflow>,
  ) {}

  list(tenantId: string): Promise<Workflow[]> {
    return this.workflows.find({
      where: { tenantId },
      order: { createdAt: 'DESC' },
    });
  }

  async get(tenantId: string, id: string): Promise<Workflow> {
    const wf = await this.workflows.findOne({ where: { id, tenantId } });
    if (!wf) throw new NotFoundException('Workflow не знайдено');
    return wf;
  }

  /** Workflow і його перша версія — в одній транзакції. */
  create(tenantId: string, input: WorkflowInput): Promise<Workflow> {
    const steps = validateSteps(input.steps);
    return this.ds.transaction(async (em) => {
      const wf = await em.save(
        em.create(Workflow, {
          tenantId,
          name: input.name,
          steps,
          cron: input.cron ?? null,
          timezone: input.timezone ?? 'UTC',
          enabled: input.enabled ?? true,
        }),
      );
      await this.saveVersion(em, wf);
      return wf;
    });
  }

  /**
   * Зміна кроків створює нову версію в тій самій транзакції. Рядок workflow блокується до кінця
   * транзакції, тож дві одночасні зміни не отримають однаковий номер версії.
   */
  async update(
    tenantId: string,
    id: string,
    input: Partial<WorkflowInput>,
  ): Promise<Workflow> {
    const steps =
      input.steps !== undefined ? validateSteps(input.steps) : undefined;
    return this.ds.transaction(async (em) => {
      const wf = await em.findOne(Workflow, {
        where: { id, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!wf) throw new NotFoundException('Workflow не знайдено');
      if (input.name !== undefined) wf.name = input.name;
      if (input.cron !== undefined) wf.cron = input.cron;
      if (input.timezone !== undefined) wf.timezone = input.timezone;
      if (input.enabled !== undefined) wf.enabled = input.enabled;
      if (steps !== undefined) {
        wf.steps = steps;
        wf.version += 1;
      }
      const saved = await em.save(wf);
      if (steps !== undefined) await this.saveVersion(em, saved);
      return saved;
    });
  }

  private async saveVersion(em: EntityManager, wf: Workflow): Promise<void> {
    await em.insert(WorkflowVersion, {
      workflowId: wf.id,
      tenantId: wf.tenantId,
      version: wf.version,
      steps: wf.steps,
    });
  }

  async remove(tenantId: string, id: string): Promise<void> {
    const wf = await this.get(tenantId, id);
    await this.workflows.remove(wf);
  }
}
