import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { Workflow, WorkflowVersion } from '../entities';
import {
  CronSchedule,
  InvalidScheduleError,
  isValidTimeZone,
} from '../scheduler/cron-schedule';
import { TenantDb } from '../tenancy/tenant-db';
import { validateSteps } from './definition';
import { CreateWorkflowDto, UpdateWorkflowDto } from './dto/workflow.dto';

/**
 * Розклад перевіряється тим самим обчисленням, що й у планувальнику: порожній чи нездійсненний
 * вираз і зона, якої немає в IANA, — 400 на межі API, а не попередження планувальника потім. Зона
 * перевіряється й без виразу: інакше її відхиляв би лише пізніший PATCH розкладу.
 */
function assertSchedule(cron: string | null, timezone: string): void {
  if (cron === null) {
    if (!isValidTimeZone(timezone))
      throw new BadRequestException([
        'schedule: timezone is not a known IANA zone',
      ]);
    return;
  }
  try {
    CronSchedule.parse(cron, timezone);
  } catch (err) {
    if (err instanceof InvalidScheduleError)
      throw new BadRequestException([`schedule: ${err.message}`]);
    throw err;
  }
}

/**
 * Workflow тенанта. Кожен запит — у контексті тенанта (RLS) і з явним предикатом `tenantId`:
 * два незалежні шари ізоляції (README, 3.3.4).
 */
@Injectable()
export class WorkflowsService {
  constructor(private readonly db: TenantDb) {}

  list(tenantId: string): Promise<Workflow[]> {
    return this.db.run(tenantId, (em) =>
      em.find(Workflow, { where: { tenantId }, order: { createdAt: 'DESC' } }),
    );
  }

  get(tenantId: string, id: string): Promise<Workflow> {
    return this.db.run(tenantId, (em) => this.getIn(em, tenantId, id));
  }

  /** Те саме в транзакції викликача (вона вже в контексті цього тенанта). */
  async getIn(
    em: EntityManager,
    tenantId: string,
    id: string,
  ): Promise<Workflow> {
    const wf = await em.findOne(Workflow, { where: { id, tenantId } });
    if (!wf) throw new NotFoundException('Workflow не знайдено');
    return wf;
  }

  /** Workflow і його перша версія — в одній транзакції. */
  create(tenantId: string, input: CreateWorkflowDto): Promise<Workflow> {
    const steps = validateSteps(input.steps);
    assertSchedule(input.cron ?? null, input.timezone ?? 'UTC');
    return this.db.run(tenantId, async (em) => {
      // Курсор розкладу — за замовчуванням БД now(), тобто момент створення: моменти до появи
      // workflow не спрацьовують.
      const wf = await em.save(
        em.create(Workflow, {
          tenantId,
          name: input.name,
          steps,
          cron: input.cron ?? null,
          timezone: input.timezone ?? 'UTC',
          enabled: input.enabled ?? true,
          missedRunPolicy: input.missedRunPolicy ?? 'run_once',
          nextFireAt:
            input.cron && input.enabled !== false ? new Date(0) : null,
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
    input: UpdateWorkflowDto,
  ): Promise<Workflow> {
    const steps =
      input.steps !== undefined ? validateSteps(input.steps) : undefined;
    return this.db.run(tenantId, async (em) => {
      const wf = await em.findOne(Workflow, {
        where: { id, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!wf) throw new NotFoundException('Workflow не знайдено');
      const cron = input.cron !== undefined ? input.cron : wf.cron;
      const timezone = input.timezone ?? wf.timezone;
      // Новий розклад (вираз, зона) чи ввімкнення починають відлік з моменту зміни: пропущені
      // моменти старого розкладу чи вимкненого періоду не наздоганяються (README 3.3.8).
      const reanchor =
        cron !== null &&
        (cron !== wf.cron ||
          timezone !== wf.timezone ||
          (input.enabled === true && !wf.enabled));
      if (cron !== wf.cron || timezone !== wf.timezone)
        assertSchedule(cron, timezone);
      if (input.name !== undefined) wf.name = input.name;
      if (!cron || input.enabled === false) {
        wf.nextFireAt = null;
        wf.scheduleError = null;
        wf.scheduleBlockedSince = null;
      }
      wf.cron = cron;
      wf.timezone = timezone;
      if (input.enabled !== undefined) wf.enabled = input.enabled;
      if (input.missedRunPolicy !== undefined)
        wf.missedRunPolicy = input.missedRunPolicy;
      if (steps !== undefined) {
        wf.steps = steps;
        wf.version += 1;
      }
      const saved = await em.save(wf);
      if (steps !== undefined) await this.saveVersion(em, saved);
      if (reanchor && wf.enabled) {
        const [rows]: [Workflow[], number] = await em.query(
          `UPDATE workflows SET "scheduleCursor" = stamp.at, "nextFireAt" = stamp.at,
                  "scheduleError" = NULL, "scheduleBlockedSince" = NULL
            FROM (SELECT clock_timestamp() AS at) stamp
            WHERE id = $1 AND "tenantId" = $2 RETURNING workflows.*`,
          [id, tenantId],
        );
        return rows[0];
      }
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
    await this.db.run(tenantId, async (em) => {
      const [, deleted]: [unknown[], number] = await em.query(
        `DELETE FROM workflows WHERE id = $1 AND "tenantId" = $2`,
        [id, tenantId],
      );
      if (deleted === 0) throw new NotFoundException('Workflow не знайдено');
    });
  }
}
