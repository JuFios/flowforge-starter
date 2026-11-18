import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Counter } from 'prom-client';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { EnvironmentVariables } from '../config/env.validation';
import { DataSource, EntityManager, Repository } from 'typeorm';
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
import { MetricsService } from '../observability/metrics.service';

@Injectable()
export class ExecutionsService {
  private readonly logger = new Logger(ExecutionsService.name);
  private readonly retried: Counter;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @InjectRepository(Execution)
    private readonly executions: Repository<Execution>,
    @InjectRepository(StepRun) private readonly stepRuns: Repository<StepRun>,
    private readonly config: ConfigService<EnvironmentVariables, true>,
    metrics: MetricsService,
  ) {
    this.retried = new Counter({
      name: 'flowforge_executions_retried_total',
      help: 'Failed executions queued again through POST /executions/:id/retry',
      registers: [metrics.registry],
    });
  }

  /**
   * Створює execution і job в одній транзакції; обидва несуть кореляційний ID поточного контексту.
   * Виконання прив'язується до версії workflow, поточної на момент створення (знімок кроків).
   */
  async enqueue(
    workflow: Workflow,
    input: Record<string, unknown>,
    trigger: Execution['trigger'],
  ): Promise<Execution> {
    return (await this.create(workflow, input, trigger, null)).execution;
  }

  /**
   * Запуск через API з ключем ідемпотентності (`Idempotency-Key`): рівно одне виконання на ключ у
   * тенанті. Повтор того самого запиту (той самий workflow і вхід) повертає наявне виконання
   * (`created: false`); той самий ключ з іншим запитом — 422. Конкурентні запити з одним ключем
   * упорядковує унікальний індекс: другий INSERT чекає на коміт першого й нічого не вставляє.
   */
  enqueueOnce(
    workflow: Workflow,
    input: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<{ execution: Execution; created: boolean }> {
    return this.create(workflow, input, 'api', idempotencyKey);
  }

  private create(
    workflow: Workflow,
    input: Record<string, unknown>,
    trigger: Execution['trigger'],
    idempotencyKey: string | null,
  ): Promise<{ execution: Execution; created: boolean }> {
    const correlationId = getCorrelationId() ?? newCorrelationId();
    return this.ds.transaction(async (em) => {
      const version = await em.findOneOrFail(WorkflowVersion, {
        where: { workflowId: workflow.id, version: workflow.version },
        select: { id: true },
      });
      const fields = {
        tenantId: workflow.tenantId,
        workflowId: workflow.id,
        workflowVersionId: version.id,
        input,
        trigger,
        correlationId,
      };
      let execution: Execution;
      if (idempotencyKey === null) {
        execution = await em.save(em.create(Execution, fields));
      } else {
        const [inserted]: Execution[] = await em.query(
          `INSERT INTO executions
             ("tenantId", "workflowId", "workflowVersionId", input, trigger, "correlationId",
              "idempotencyKey")
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
           ON CONFLICT ("tenantId", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL
           DO NOTHING
           RETURNING *`,
          [
            fields.tenantId,
            fields.workflowId,
            fields.workflowVersionId,
            JSON.stringify(input),
            trigger,
            correlationId,
            idempotencyKey,
          ],
        );
        if (!inserted)
          return {
            execution: await this.existingRun(
              em,
              workflow,
              input,
              idempotencyKey,
            ),
            created: false,
          };
        execution = inserted;
      }
      await em.save(
        em.create(Job, {
          tenantId: workflow.tenantId,
          executionId: execution.id,
          maxAttempts: this.config.get('JOB_MAX_ATTEMPTS', { infer: true }),
          correlationId,
        }),
      );
      return { execution, created: true };
    });
  }

  /** Виконання, уже створене з цим ключем; інший workflow чи вхід — 422. */
  private async existingRun(
    em: EntityManager,
    workflow: Workflow,
    input: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<Execution> {
    // Вхід порівнюється як jsonb: порядок ключів і пробіли не мають значення.
    const [row]: Array<Execution & { sameRequest: boolean }> = await em.query(
      `SELECT *, ("workflowId" = $3 AND input = $4::jsonb) AS "sameRequest"
         FROM executions WHERE "tenantId" = $1 AND "idempotencyKey" = $2`,
      [workflow.tenantId, idempotencyKey, workflow.id, JSON.stringify(input)],
    );
    // Виконання з цим ключем щойно видалило очищення історії: запит варто повторити.
    if (!row)
      throw new ConflictException(
        'виконання з цим Idempotency-Key щойно видалено, повторіть запит',
      );
    if (!row.sameRequest)
      throw new UnprocessableEntityException(
        'Idempotency-Key уже використано для іншого запуску (інший workflow або вхідні дані)',
      );
    // Службове поле порівняння у відповідь не потрапляє.
    delete (row as Partial<typeof row>).sameRequest;
    return row;
  }

  /**
   * Повтор виконання, що завершилось `failed` (зокрема задача `dead`), — лише свого тенанта.
   * Виконання продовжується з першого незавершеного кроку з новим бюджетом спроб: завершені кроки
   * не повторюються, а повторений крок `http` надсилає той самий `Idempotency-Key`, що й раніше.
   * Виконання й задача змінюються в одній транзакції; рядок виконання блокується, тож із двох
   * одночасних повторів пройде один.
   */
  async retry(tenantId: string, id: string): Promise<Execution> {
    const correlationId = getCorrelationId() ?? newCorrelationId();
    const execution = await this.ds.transaction(async (em) => {
      const [row]: Execution[] = await em.query(
        `SELECT * FROM executions WHERE id = $1 AND "tenantId" = $2 FOR UPDATE`,
        [id, tenantId],
      );
      if (!row) throw new NotFoundException('Execution не знайдено');
      if (row.status !== 'failed')
        throw new ConflictException(
          `повторити можна лише виконання зі статусом failed (зараз: ${row.status})`,
        );
      if (!row.workflowVersionId)
        throw new ConflictException(
          'виконання створене до появи знімків версій workflow і не може бути повторене',
        );
      const [{ started }]: Array<{ started: boolean }> = await em.query(
        `SELECT EXISTS (SELECT 1 FROM step_runs WHERE "executionId" = $1) AS started`,
        [id],
      );
      const [updated]: [Execution[], number] = await em.query(
        `UPDATE executions SET status = $2, error = NULL, output = NULL, "finishedAt" = NULL
          WHERE id = $1 RETURNING *`,
        [id, started ? 'running' : 'pending'],
      );
      const maxAttempts = this.config.get('JOB_MAX_ATTEMPTS', { infer: true });
      // Задача — та сама (завершена), або нова, якщо її вже видалило очищення (JOB_RETENTION_DAYS).
      const [, requeued]: [unknown[], number] = await em.query(
        `UPDATE jobs
            SET status = 'queued', attempts = 0, "maxAttempts" = $2, "runAt" = now(),
                "lastError" = NULL, "finishedAt" = NULL, "correlationId" = $3,
                "lockedBy" = NULL, "lockedUntil" = NULL, "lockToken" = NULL
          WHERE "executionId" = $1 AND status IN ('done', 'failed', 'dead')`,
        [id, maxAttempts, correlationId],
      );
      if (requeued === 0)
        await em.save(
          em.create(Job, {
            tenantId,
            executionId: id,
            maxAttempts,
            correlationId,
          }),
        );
      return updated[0];
    });
    this.retried.inc();
    this.logger.log(
      { executionId: id, originalCorrelationId: execution.correlationId },
      'failed execution queued again',
    );
    return execution;
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
