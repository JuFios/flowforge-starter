import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
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
