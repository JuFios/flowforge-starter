import {
  cursorAtSql,
  decodeKeysetCursor,
  toPage,
} from '../common/keyset-cursor';
import { ListExecutionsQuery } from './list-executions.query';
import {
  ConflictException,
  UnauthorizedException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Counter } from 'prom-client';
import { ConfigService } from '@nestjs/config';
import { EnvironmentVariables } from '../config/env.validation';
import { EntityManager } from 'typeorm';
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
import {
  OutboxFullException,
  QueueFullException,
} from '../limits/limit-exceptions';
import { LimitsMetrics } from '../limits/limits.metrics';
import { MetricsService } from '../observability/metrics.service';
import {
  readClock,
  VerifiedDelivery,
  WEBHOOK_WINDOW_SECONDS,
} from '../webhooks/webhook-signature';
import { TenantDb } from '../tenancy/tenant-db';

/** Джерело постановки (мітка метрики відхилених постановок). */
type EnqueueTrigger = Execution['trigger'] | 'retry';

/** Лічильники й ліміт черги тенанта з його рядка обліку. */
interface QueueUsage {
  queued: number;
  running: number;
  maxQueueSize: number;
  /** Недоставлені події outbox тенанта і квота outbox (міграція OutboxQuota). */
  outboxUndelivered: number;
  maxOutboxEvents: number;
}

@Injectable()
export class ExecutionsService {
  private readonly logger = new Logger(ExecutionsService.name);
  private readonly retried: Counter;

  constructor(
    private readonly db: TenantDb,
    private readonly config: ConfigService<EnvironmentVariables, true>,
    metrics: MetricsService,
    private readonly limits: LimitsMetrics,
  ) {
    this.retried = new Counter({
      name: 'flowforge_executions_retried_total',
      help: 'Failed executions queued again through POST /executions/:id/retry',
      registers: [metrics.registry],
    });
  }

  /**
   * Спрацювання розкладу в транзакції планувальника `em` (вона вже в контексті тенанта workflow і
   * тримає блокування його рядка): облік тенанта → наявне виконання цього моменту → ліміт черги →
   * виконання й задача. Повертає, чи створено нове. Повна черга — QueueFullException, і
   * транзакція планувальника відкочується разом із курсором.
   */
  async enqueueScheduledIn(
    em: EntityManager,
    workflow: Workflow,
    scheduledAt: Date,
    correlationId: string,
  ): Promise<boolean> {
    const usage = await this.lockUsage(em);
    const existing = await em.findOneBy(Execution, {
      tenantId: workflow.tenantId,
      workflowId: workflow.id,
      scheduledAt,
    });
    if (existing) return false;
    const { created } = await this.insertExecution(
      em,
      workflow,
      {},
      'cron',
      null,
      scheduledAt,
      correlationId,
      usage,
    );
    return created;
  }

  /**
   * Читання версії та постановка виконання й задачі — одна транзакція. Блокування workflow
   * упорядковує запуск із редагуванням і видаленням, а блокування обліку — з іншими постановками.
   * Повтор того самого запиту з ключем повертає наявне виконання навіть після видалення workflow.
   */
  enqueue(
    target: Pick<Workflow, 'id' | 'tenantId'>,
    input: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<{ execution: Execution; created: boolean }> {
    return this.db.run(target.tenantId, async (em) => {
      const workflow = await em.findOne(Workflow, {
        where: { id: target.id, tenantId: target.tenantId },
        lock: { mode: 'pessimistic_read' },
      });
      if (!workflow && idempotencyKey === undefined)
        throw new NotFoundException('Workflow не знайдено');
      const usage = await this.lockUsage(em);
      if (idempotencyKey !== undefined) {
        const existing = await this.findRun(em, target, input, idempotencyKey);
        if (existing) return { execution: existing, created: false };
      }
      if (!workflow) throw new NotFoundException('Workflow не знайдено');
      return this.insertExecution(
        em,
        workflow,
        input,
        'api',
        idempotencyKey ?? null,
        null,
        getCorrelationId() ?? newCorrelationId(),
        usage,
      );
    });
  }

  /**
   * Блокує рядок обліку тенанта до кінця транзакції (`lock_tenant_usage`) і повертає його
   * лічильники: постановки тенанта серіалізуються, тож перевірка ліміту черги й вставка задачі
   * атомарні.
   */
  private async lockUsage(em: EntityManager): Promise<QueueUsage> {
    const [usage]: QueueUsage[] = await em.query(
      'SELECT queued, running, "maxQueueSize", "outboxUndelivered", "maxOutboxEvents" FROM lock_tenant_usage()',
    );
    return usage;
  }

  /**
   * Місце для нового циклу виконання (docs/architecture.md, «Контракт лімітів»): у черзі (повна —
   * 429 `queue_full`) і в квоті outbox, бо кожен цикл завершиться щонайбільше однією подією
   * (недоставлені + живі виконання ≥ квоти — 429 `outbox_full`).
   */
  private assertQueueSlot(usage: QueueUsage, trigger: EnqueueTrigger): void {
    const live = usage.queued + usage.running;
    if (live >= usage.maxQueueSize) {
      this.limits.enqueueRejected.inc({ reason: 'queue_full', trigger });
      throw new QueueFullException(usage.maxQueueSize);
    }
    if (usage.outboxUndelivered + live >= usage.maxOutboxEvents) {
      this.limits.enqueueRejected.inc({ reason: 'outbox_full', trigger });
      throw new OutboxFullException(
        usage.maxOutboxEvents,
        usage.outboxUndelivered,
      );
    }
  }

  /**
   * Постановка автентифікованої доставки. `parseInput` викликається лише для нової доставки
   * увімкненого workflow: повтор прийнятої повертає її виконання, а вимкнений workflow відповідає
   * 404 до розбору тіла й без блокування обліку тенанта.
   */
  async enqueueWebhook(
    target: Workflow,
    parseInput: () => Record<string, unknown>,
    proof: VerifiedDelivery,
  ): Promise<string> {
    return this.db.run(target.tenantId, async (em) => {
      // Порядок блокувань однаковий для всіх доставок. Зміна ключів блокує лише тенанта.
      const [keys]: Array<{
        webhookKeyId: string;
        nextWebhookKeyId: string | null;
      }> = await em.query(
        'SELECT "webhookKeyId","nextWebhookKeyId" FROM tenants WHERE id=$1 FOR SHARE',
        [target.tenantId],
      );
      const workflow = await em.findOne(Workflow, {
        where: { id: target.id, tenantId: target.tenantId },
        lock: { mode: 'pessimistic_read' },
      });
      if (!workflow) throw new NotFoundException();
      if (
        !keys ||
        (keys.webhookKeyId !== proof.keyId &&
          keys.nextWebhookKeyId !== proof.keyId) ||
        Math.abs((await readClock(em)) - proof.timestamp) >
          WEBHOOK_WINDOW_SECONDS
      )
        throw new UnauthorizedException('Невірний підпис');
      const params = [workflow.tenantId, workflow.id, proof.deliveryId];
      const receipt = async (): Promise<string | undefined> => {
        const [existing]: Array<{ executionId: string; bodyHash: Buffer }> =
          await em.query(
            'SELECT "executionId","bodyHash" FROM webhook_deliveries WHERE "tenantId"=$1 AND "workflowId"=$2 AND "deliveryId"=$3',
            params,
          );
        if (existing && !existing.bodyHash.equals(proof.digest))
          throw new ConflictException(
            'Ідентифікатор доставки вже використано з іншим тілом',
          );
        return existing?.executionId;
      };
      // Вимкнений workflow (FOR SHARE вище не дає його ввімкнути до COMMIT) нових доставок не
      // приймає, тож квитанція не може з'явитися паралельно, і облік тенанта не потрібен.
      if (!workflow.enabled) {
        const accepted = await receipt();
        if (accepted) return accepted;
        throw new NotFoundException();
      }
      const usage = await this.lockUsage(em);
      // Після блокування обліку: паралельна доставка того самого ID уже закомічена й видна.
      const accepted = await receipt();
      if (accepted) return accepted;
      const { execution } = await this.insertExecution(
        em,
        workflow,
        parseInput(),
        'webhook',
        null,
        null,
        getCorrelationId() ?? newCorrelationId(),
        usage,
      );
      await em.query(
        'INSERT INTO webhook_deliveries ("tenantId","workflowId","deliveryId","bodyHash","executionId") VALUES ($1,$2,$3,$4,$5)',
        [...params, proof.digest, execution.id],
      );
      return execution.id;
    });
  }

  private async insertExecution(
    em: EntityManager,
    workflow: Workflow,
    input: Record<string, unknown>,
    trigger: Execution['trigger'],
    idempotencyKey: string | null,
    scheduledAt: Date | null,
    correlationId: string,
    usage: QueueUsage,
  ): Promise<{ execution: Execution; created: boolean }> {
    this.assertQueueSlot(usage, trigger);
    const version = await em.findOneOrFail(WorkflowVersion, {
      where: {
        workflowId: workflow.id,
        version: workflow.version,
        tenantId: workflow.tenantId,
      },
      select: { id: true },
    });
    const fields = {
      tenantId: workflow.tenantId,
      workflowId: workflow.id,
      workflowVersionId: version.id,
      scheduledAt,
      input,
      trigger,
      correlationId,
    };
    let execution: Execution;
    if (idempotencyKey === null) {
      execution = await em.save(em.create(Execution, fields));
    } else {
      // Постановки тенанта серіалізовані блокуванням обліку, тож конфлікт ключа тут неможливий;
      // ON CONFLICT лишається страховкою унікального індексу.
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
  }

  /**
   * Виконання, уже створене з цим ключем, або undefined; той самий ключ з іншим workflow чи
   * входом — 422.
   */
  private async findRun(
    em: EntityManager,
    workflow: Pick<Workflow, 'id' | 'tenantId'>,
    input: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<Execution | undefined> {
    // Вхід порівнюється як jsonb: порядок ключів і пробіли не мають значення.
    const [row]: Array<Execution & { sameRequest: boolean }> = await em.query(
      `SELECT *, ("workflowId" = $3 AND input = $4::jsonb) AS "sameRequest"
         FROM executions WHERE "tenantId" = $1 AND "idempotencyKey" = $2`,
      [workflow.tenantId, idempotencyKey, workflow.id, JSON.stringify(input)],
    );
    if (!row) return undefined;
    if (!row.sameRequest)
      throw new UnprocessableEntityException(
        'Idempotency-Key уже використано для іншого запуску (інший workflow або вхідні дані)',
      );
    // Службове поле порівняння у відповідь не потрапляє.
    delete (row as Partial<typeof row>).sameRequest;
    return row;
  }

  /** Виконання, з яким щойно конфліктувала вставка за ключем; інший workflow чи вхід — 422. */
  private async existingRun(
    em: EntityManager,
    workflow: Workflow,
    input: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<Execution> {
    const row = await this.findRun(em, workflow, input, idempotencyKey);
    // Виконання з цим ключем щойно видалило очищення історії: запит варто повторити.
    if (!row)
      throw new ConflictException(
        'виконання з цим Idempotency-Key щойно видалено, повторіть запит',
      );
    return row;
  }

  /**
   * Повтор виконання, що завершилось `failed` (зокрема задача `dead`), — лише свого тенанта.
   * Виконання продовжується з першого незавершеного кроку з новим бюджетом спроб: завершені кроки
   * не повторюються, а повторений крок `http` надсилає той самий `Idempotency-Key`, що й раніше.
   * Виконання й задача змінюються в одній транзакції; рядок виконання блокується, тож із двох
   * одночасних повторів пройде один.
   */
  async retry(
    tenantId: string,
    id: string,
    expectedTerminalCycle?: number,
  ): Promise<Execution> {
    const correlationId = getCorrelationId() ?? newCorrelationId();
    const execution = await this.db.run(tenantId, async (em) => {
      const [row]: Execution[] = await em.query(
        `SELECT * FROM executions WHERE id = $1 AND "tenantId" = $2 FOR UPDATE`,
        [id, tenantId],
      );
      if (!row) throw new NotFoundException('Execution не знайдено');
      if (
        expectedTerminalCycle !== undefined &&
        (row.terminalCycles !== expectedTerminalCycle ||
          row.status !== 'failed')
      )
        throw new ConflictException({
          statusCode: 409,
          error: 'retry_cycle_conflict',
          message:
            'Цей термінальний цикл уже змінився. Перевірте стан виконання.',
        });
      if (row.status !== 'failed')
        throw new ConflictException(
          `повторити можна лише виконання зі статусом failed (зараз: ${row.status})`,
        );
      if (!row.workflowVersionId)
        throw new ConflictException(
          'виконання створене до появи знімків версій workflow і не може бути повторене',
        );
      // Порядок блокувань: виконання → облік тенанта → задача (docs/architecture.md, «Порядок блокувань»).
      this.assertQueueSlot(await this.lockUsage(em), 'retry');
      const [{ started }]: Array<{ started: boolean }> = await em.query(
        `SELECT EXISTS (SELECT 1 FROM step_runs WHERE "executionId" = $1 AND "tenantId" = $2) AS started`,
        [id, tenantId],
      );
      const [updated]: [Execution[], number] = await em.query(
        `UPDATE executions SET status = $2, error = NULL, output = NULL, "finishedAt" = NULL
          WHERE id = $1 AND "tenantId" = $3 RETURNING *`,
        [id, started ? 'running' : 'pending', tenantId],
      );
      const maxAttempts = this.config.get('JOB_MAX_ATTEMPTS', { infer: true });
      // Задача — та сама (завершена), або нова, якщо її вже видалило очищення (JOB_RETENTION_DAYS).
      const [, requeued]: [unknown[], number] = await em.query(
        `UPDATE jobs
            SET status = 'queued', attempts = 0, "maxAttempts" = $2, "runAt" = now(),
                "lastError" = NULL, "finishedAt" = NULL, "correlationId" = $3,
                "lockedBy" = NULL, "lockedUntil" = NULL, "lockToken" = NULL
          WHERE "executionId" = $1 AND "tenantId" = $4 AND status IN ('done', 'failed', 'dead')`,
        [id, maxAttempts, correlationId, tenantId],
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

  async list(tenantId: string, query: ListExecutionsQuery = {}) {
    const workflowId = query.workflowId?.toLowerCase();
    const scope = `${query.status ?? ''}:${workflowId ?? ''}`;
    const after = query.cursor
      ? decodeKeysetCursor(query.cursor, scope)
      : undefined;
    const limit = query.limit ?? 50;
    const params: unknown[] = [tenantId, limit + 1];
    const where = ['e."tenantId" = $1'];
    if (query.status) where.push(`e.status = $${params.push(query.status)}`);
    if (workflowId)
      where.push(`e."workflowId" = $${params.push(workflowId)}::uuid`);
    if (after) {
      const at = params.push(after.createdAt);
      const id = params.push(after.id);
      where.push(`(e."createdAt", e.id) < ($${at}::timestamptz, $${id}::uuid)`);
    }
    type Row = Pick<
      Execution,
      | 'id'
      | 'workflowId'
      | 'status'
      | 'trigger'
      | 'error'
      | 'createdAt'
      | 'finishedAt'
      | 'scheduledAt'
      | 'correlationId'
    > & {
      workflowName: string | null;
      workflowVersion: number | null;
      cursorAt: string;
    };
    const rows = await this.db.run(tenantId, (em) =>
      em.query<Row[]>(
        `SELECT e.id, e."workflowId", w.name AS "workflowName", v.version AS "workflowVersion",
              e.status, e.trigger, left(e.error,500) AS error, e."createdAt", e."finishedAt",
              e."scheduledAt", e."correlationId", ${cursorAtSql('e."createdAt"')} AS "cursorAt"
         FROM executions e
         LEFT JOIN workflows w ON w.id=e."workflowId" AND w."tenantId"=e."tenantId"
         LEFT JOIN workflow_versions v ON v.id=e."workflowVersionId" AND v."tenantId"=e."tenantId"
        WHERE ${where.join(' AND ')}
        ORDER BY e."createdAt" DESC, e.id DESC LIMIT $2`,
        params,
      ),
    );
    return toPage(rows, limit, scope);
  }

  /** Виконання тенанта разом із кроками; чуже виконання — 404, як неіснуюче. */
  async get(
    tenantId: string,
    id: string,
  ): Promise<Execution & { steps: StepRun[] }> {
    return this.db.run(tenantId, async (em) => {
      const execution = await em.findOne(Execution, {
        where: { id, tenantId },
      });
      if (!execution) throw new NotFoundException('Execution не знайдено');
      const steps = await em.find(StepRun, {
        where: { executionId: execution.id, tenantId },
        order: { stepIndex: 'ASC', startedAt: 'ASC' },
      });
      return { ...execution, steps };
    });
  }
}
