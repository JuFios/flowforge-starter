import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { EnvironmentVariables } from '../../src/config/env.validation';
import { CheckpointService } from '../../src/engine/checkpoint.service';
import { JobQueueService } from '../../src/engine/job-queue.service';
import { Execution, Job, StepRun, Workflow } from '../../src/entities';
import { ExecutionsService } from '../../src/executions/executions.service';
import { LimitsMetrics } from '../../src/limits/limits.metrics';
import { MetricsService } from '../../src/observability/metrics.service';
import { SystemDb } from '../../src/tenancy/system-db';
import { TenantDb } from '../../src/tenancy/tenant-db';
import { WorkflowsService } from '../../src/workflows/workflows.service';
import {
  createExecution,
  createTenant,
  createWorkflow,
  openTestDataSource,
  truncateAll,
} from '../helpers/db';

/**
 * Перший шар ізоляції — явні предикати `tenantId` у коді — доводиться окремо від RLS: сервіси
 * працюють тут через з'єднання власника схеми (суперкористувач обходить RLS), тож чуже приховує
 * лише сам запит сервісу. Прибраний предикат робить ці тести червоними (README, мутаційна
 * перевірка), хоча HTTP-тести ізоляції лишились би зеленими завдяки RLS.
 */
describe('tenant predicates in the services (row-level security bypassed)', () => {
  let owner: DataSource;
  let db: TenantDb;
  let workflows: WorkflowsService;
  let executions: ExecutionsService;
  let queue: JobQueueService;
  let checkpoints: CheckpointService;
  let a: string;
  let b: string;
  let wfA: Workflow;
  let failedA: Execution;
  let jobA: Job;

  beforeAll(async () => {
    owner = await openTestDataSource();
    db = new TenantDb(owner);
    const config = new ConfigService<EnvironmentVariables, true>({
      JOB_MAX_ATTEMPTS: 3,
      JOB_LEASE_MS: 30_000,
      JOB_BACKOFF_BASE_MS: 50,
      JOB_BACKOFF_MAX_MS: 500,
    });
    workflows = new WorkflowsService(db);
    const metrics = new MetricsService();
    executions = new ExecutionsService(
      db,
      config,
      metrics,
      new LimitsMetrics(metrics),
    );
    queue = new JobQueueService(db, new SystemDb(owner), config);
    checkpoints = new CheckpointService(db, queue);
  });

  beforeEach(async () => {
    await truncateAll(owner);
    a = (await createTenant(owner, 'a')).tenant.id;
    b = (await createTenant(owner, 'b')).tenant.id;
    wfA = await createWorkflow(owner, a, 'wf-a');
    failedA = await createExecution(owner, wfA, {
      status: 'failed',
      finishedAt: new Date(),
    });
    await owner.getRepository(StepRun).insert({
      executionId: failedA.id,
      tenantId: a,
      stepIndex: 0,
      stepId: 'say',
      status: 'failed',
    });
    jobA = await owner.getRepository(Job).save({
      tenantId: a,
      executionId: failedA.id,
      status: 'running',
      lockToken: '00000000-0000-4000-8000-0000000000aa',
      lockedUntil: new Date(Date.now() + 60_000),
    });
  });

  afterAll(async () => {
    await truncateAll(owner);
    await owner.destroy();
  });

  it('workflows of A are invisible and immutable for B', async () => {
    await expect(workflows.get(b, wfA.id)).rejects.toThrow(NotFoundException);
    await expect(
      workflows.update(b, wfA.id, { name: 'hijacked' }),
    ).rejects.toThrow(NotFoundException);
    await expect(workflows.remove(b, wfA.id)).rejects.toThrow(
      NotFoundException,
    );
    expect((await workflows.list(b, {})).items.map((w) => w.id)).not.toContain(
      wfA.id,
    );
    expect(
      await owner.getRepository(Workflow).findOneByOrFail({ id: wfA.id }),
    ).toMatchObject({ name: 'wf-a' });
  });

  it('executions of A are invisible and cannot be retried by B', async () => {
    await expect(executions.get(b, failedA.id)).rejects.toThrow(
      NotFoundException,
    );
    expect((await executions.list(b)).map((e) => e.id)).not.toContain(
      failedA.id,
    );
    await expect(executions.retry(b, failedA.id)).rejects.toThrow(
      NotFoundException,
    );
    expect(
      await owner.getRepository(Execution).findOneByOrFail({ id: failedA.id }),
    ).toMatchObject({ status: 'failed' });
  });

  it('the steps of an execution are read only within its tenant', async () => {
    const asB = { ...jobA, tenantId: b };
    const steps = await db.run(b, (em) => checkpoints.load(em, asB));
    expect(steps).toEqual([]);
  });

  it('finishes the execution and fenced job in one statement after entering the tenant transaction', async () => {
    const statements: string[] = [];
    const observer = {
      afterQuery: (event: { query: string }) => {
        if (
          !/^(?:START TRANSACTION|COMMIT|SELECT set_config\()/i.test(
            event.query.trim(),
          )
        )
          statements.push(event.query);
      },
    };
    owner.subscribers.push(observer);
    try {
      await checkpoints.finish(jobA, { ok: true });
      expect(statements).toHaveLength(1);
      expect(
        await owner
          .getRepository(Execution)
          .findOneByOrFail({ id: jobA.executionId }),
      ).toMatchObject({ status: 'succeeded', output: { ok: true } });
      await expect(checkpoints.finish(jobA, { ok: false })).rejects.toThrow(
        /no longer held/,
      );
      expect(
        await owner
          .getRepository(Execution)
          .findOneByOrFail({ id: jobA.executionId }),
      ).toMatchObject({ output: { ok: true } });
    } finally {
      owner.subscribers.splice(owner.subscribers.indexOf(observer), 1);
    }
  });

  it('rejects a different tenant, token or execution before finishing either row', async () => {
    const other = await createExecution(owner, wfA, { status: 'running' });
    for (const invalid of [
      { ...jobA, tenantId: b },
      { ...jobA, lockToken: other.id },
      { ...jobA, executionId: other.id },
    ]) {
      await expect(checkpoints.finish(invalid, 'incorrect')).rejects.toThrow(
        /no longer held/,
      );
    }
    const executions = owner.getRepository(Execution);
    expect(
      await executions.findOneByOrFail({ id: jobA.executionId }),
    ).toMatchObject({ status: 'failed' });
    expect(await executions.findOneByOrFail({ id: other.id })).toMatchObject({
      status: 'running',
    });
    expect(
      await owner.getRepository(Job).findOneByOrFail({ id: jobA.id }),
    ).toMatchObject({ status: 'running', lockToken: jobA.lockToken });
  });

  it('a lease of A is not renewed, asserted or released in the name of B', async () => {
    const asB = { ...jobA, tenantId: b };
    expect(await queue.heartbeat(asB)).toBe(false);
    await expect(db.run(b, (em) => queue.assertLease(em, asB))).rejects.toThrow(
      /no longer held/,
    );
    await expect(queue.release(asB)).rejects.toThrow(/no longer held/);
    expect(
      await owner.getRepository(Job).findOneByOrFail({ id: jobA.id }),
    ).toMatchObject({ status: 'running' });
  });
});
