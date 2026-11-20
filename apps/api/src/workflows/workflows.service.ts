import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EntityManager, QueryFailedError } from 'typeorm';
import {
  cursorAtSql,
  decodeKeysetCursor,
  Page,
  toPage,
} from '../common/keyset-cursor';
import { WORKFLOW_QUOTA_SQLSTATE } from '../tenancy/limits';
import { WorkflowLimitException } from '../limits/limit-exceptions';
import { Workflow, WorkflowVersion } from '../entities';
import {
  CronSchedule,
  InvalidScheduleError,
  isValidTimeZone,
} from '../scheduler/cron-schedule';
import { TenantDb } from '../tenancy/tenant-db';
import { validateSteps } from './definition';
import {
  DEFAULT_WORKFLOW_PAGE,
  ListWorkflowsQuery,
} from './dto/list-workflows.query';
import { CreateWorkflowDto, UpdateWorkflowDto } from './dto/workflow.dto';

/** Поля огляду workflow у списку: без `steps`, тож обсяг сторінки не залежить від визначень. */
export interface WorkflowSummary {
  id: string;
  name: string;
  enabled: boolean;
  cron: string | null;
  timezone: string;
  version: number;
  missedRunPolicy: Workflow['missedRunPolicy'];
  nextFireAt: Date | null;
  scheduleBlockedSince: Date | null;
  scheduleError: string | null;
  createdAt: Date;
}

/**
 * Колонки огляду. `steps` у SELECT немає: jsonb визначення (до 64 КіБ, у TOAST) не читається з
 * диска й не потрапляє в пам'ять API.
 */
const SUMMARY_COLUMNS = `id, name, enabled, cron, timezone, version, "missedRunPolicy",
  "nextFireAt", "scheduleBlockedSince", "scheduleError", "createdAt"`;

/** Відмова тригера квоти (SQLSTATE FF001, межа — у DETAIL) → 429 workflow_limit_reached. */
function quotaRejection(err: unknown): WorkflowLimitException | undefined {
  if (!(err instanceof QueryFailedError)) return undefined;
  const driver = err.driverError as { code?: unknown; detail?: unknown };
  if (driver.code !== WORKFLOW_QUOTA_SQLSTATE) return undefined;
  return new WorkflowLimitException(Number(driver.detail));
}

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

  /**
   * Сторінка списку: `ORDER BY "createdAt" DESC, id DESC` з предикатом курсора — один діапазон
   * індексу IDX_workflows_tenant_created. LIMIT на один більше показує, чи є наступна сторінка.
   */
  async list(
    tenantId: string,
    query: ListWorkflowsQuery,
  ): Promise<Page<WorkflowSummary>> {
    const limit = query.limit ?? DEFAULT_WORKFLOW_PAGE;
    const after = query.cursor ? decodeKeysetCursor(query.cursor) : null;
    const params: unknown[] = [tenantId, limit + 1];
    let where = '"tenantId" = $1';
    if (after) {
      params.push(after.createdAt, after.id);
      where += ` AND ("createdAt", id) < ($3::timestamptz, $4::uuid)`;
    }
    const rows: Array<WorkflowSummary & { cursorAt: string }> =
      await this.db.run(tenantId, (em) =>
        em.query(
          `SELECT ${SUMMARY_COLUMNS}, ${cursorAtSql('"createdAt"')} AS "cursorAt"
             FROM workflows WHERE ${where}
            ORDER BY "createdAt" DESC, id DESC LIMIT $2`,
          params,
        ),
      );
    return toPage(rows, limit);
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

  /**
   * Workflow і його перша версія — в одній транзакції. Квоту перевіряє тригер БД під блокуванням
   * тенанта в тій самій транзакції (міграція WorkflowQuota).
   */
  async create(tenantId: string, input: CreateWorkflowDto): Promise<Workflow> {
    const steps = validateSteps(input.steps);
    assertSchedule(input.cron ?? null, input.timezone ?? 'UTC');
    try {
      return await this.insert(tenantId, input, steps);
    } catch (err) {
      throw quotaRejection(err) ?? err;
    }
  }

  private insert(
    tenantId: string,
    input: CreateWorkflowDto,
    steps: Workflow['steps'],
  ): Promise<Workflow> {
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
    return this.db.run(tenantId, async (em) => {
      const wf = await em.findOne(Workflow, {
        where: { id, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!wf) throw new NotFoundException('Workflow не знайдено');
      const steps =
        input.steps === undefined
          ? undefined
          : validateSteps(input.steps, wf.steps);
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
