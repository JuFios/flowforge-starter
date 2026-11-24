import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { EnvironmentVariables } from '../../src/config/env.validation';
import { CheckpointService } from '../../src/engine/checkpoint.service';
import {
  JobQueueService,
  LeaseLostError,
} from '../../src/engine/job-queue.service';
import { Execution, Job, StepRun } from '../../src/entities';
import { SystemDb } from '../../src/tenancy/system-db';
import { TenantDb } from '../../src/tenancy/tenant-db';
import {
  createExecution,
  createTenant,
  createWorkflow,
  openTestDataSource,
  truncateAll,
} from '../helpers/db';

/**
 * Межі транзакцій кроку (docs/architecture.md, «Межі транзакцій кроку»): початок спроби кроку й
 * чекпоінт — по одному оператору всередині транзакції тенанта, читання для відновлення — два.
 * Кількість звернень до БД детермінована й не залежить від заліза, тож тут вона перевіряється
 * точно; вартість під навантаженням звітує `bench:claim -- steps`.
 */
describe('statements per step transition', () => {
  let owner: DataSource;
  let db: TenantDb;
  let checkpoints: CheckpointService;
  let queue: JobQueueService;
  let tenantId: string;
  let execution: Execution;
  let job: Job;
  const statements: string[] = [];
  const observer = {
    afterQuery: (event: { query: string }) => {
      statements.push(event.query.trim());
    },
  };

  /** Звернення до БД під час `fn` (усі, включно з BEGIN, контекстом тенанта й COMMIT). */
  async function count<T>(
    fn: () => Promise<T>,
  ): Promise<{ result: T; statements: string[] }> {
    statements.length = 0;
    owner.subscribers.push(observer);
    try {
      const result = await fn();
      return { result, statements: [...statements] };
    } finally {
      owner.subscribers.splice(owner.subscribers.indexOf(observer), 1);
    }
  }

  beforeAll(async () => {
    owner = await openTestDataSource();
    db = new TenantDb(owner);
    const config = new ConfigService<EnvironmentVariables, true>({
      JOB_MAX_ATTEMPTS: 3,
      JOB_LEASE_MS: 30_000,
      JOB_BACKOFF_BASE_MS: 50,
      JOB_BACKOFF_MAX_MS: 500,
    });
    queue = new JobQueueService(db, new SystemDb(owner), config);
    checkpoints = new CheckpointService(db, queue);
  });

  beforeEach(async () => {
    await truncateAll(owner);
    tenantId = (await createTenant(owner)).tenant.id;
    execution = await createExecution(
      owner,
      await createWorkflow(owner, tenantId),
      { input: { name: 'x' } },
    );
    job = await owner.getRepository(Job).save({
      tenantId,
      executionId: execution.id,
      status: 'running',
      lockToken: '00000000-0000-4000-8000-0000000000aa',
      lockedUntil: new Date(Date.now() + 60_000),
    });
  });

  afterAll(async () => {
    await truncateAll(owner);
    await owner.destroy();
  });

  it('starts a step in one statement: the attempt is counted, the step row created and the execution running', async () => {
    const { result: run, statements } = await count(() =>
      checkpoints.startStep(job, 0, 'say'),
    );
    expect(statements).toHaveLength(4);
    expect(statements[0]).toMatch(/^START TRANSACTION/);
    expect(statements[1]).toMatch(/^SELECT set_config/);
    expect(statements[3]).toMatch(/^COMMIT/);
    expect(run).toMatchObject({
      executionId: execution.id,
      stepIndex: 0,
      stepId: 'say',
      status: 'running',
      attempts: 1,
    });
    expect(
      await owner.getRepository(Job).findOneByOrFail({ id: job.id }),
    ).toMatchObject({ attempts: 1, status: 'running' });
    expect(
      await owner
        .getRepository(Execution)
        .findOneByOrFail({ id: execution.id }),
    ).toMatchObject({ status: 'running' });

    // Повторна спроба того самого кроку: той самий рядок, лічильник спроб кроку зростає, а
    // лічильник задачі, вже ненульовий, не змінюється.
    await owner.getRepository(Job).update(job.id, { attempts: 2 });
    const again = await checkpoints.startStep(job, 0, 'say');
    expect(again).toMatchObject({ id: run.id, attempts: 2 });
    expect(
      await owner.getRepository(Job).findOneByOrFail({ id: job.id }),
    ).toMatchObject({ attempts: 2 });
  });

  it('checkpoints a step in one statement and resets the attempt counter', async () => {
    const run = await checkpoints.startStep(job, 0, 'say');
    const { result: saved, statements } = await count(() =>
      checkpoints.checkpoint(job, run, { said: 'hello' }),
    );
    expect(statements).toHaveLength(4);
    expect(saved.output).toEqual({ said: 'hello' });
    expect(saved.finishedAt).toBeInstanceOf(Date);
    expect(
      await owner.getRepository(StepRun).findOneByOrFail({ id: run.id }),
    ).toMatchObject({ status: 'succeeded', output: { said: 'hello' } });
    expect(
      await owner.getRepository(Job).findOneByOrFail({ id: job.id }),
    ).toMatchObject({ attempts: 0 });
  });

  it('reads the state to resume from in two statements', async () => {
    const run = await checkpoints.startStep(job, 0, 'say');
    await checkpoints.checkpoint(job, run, 'done');
    const { result, statements } = await count(() =>
      db.run(tenantId, (em) => checkpoints.resume(em, job)),
    );
    expect(statements).toHaveLength(5);
    expect(result.input).toEqual({ name: 'x' });
    expect(result.steps).toEqual([
      { id: 'say', type: 'log', message: 'hello {{ input.name }}' },
    ]);
    expect(result.history).toHaveLength(1);
    expect(result.history[0]).toMatchObject({
      stepIndex: 0,
      status: 'succeeded',
      output: 'done',
    });
  });

  it('writes nothing when the lease is gone: the step is not started and the checkpoint is not saved', async () => {
    const run = await checkpoints.startStep(job, 0, 'say');
    const stolen = {
      ...job,
      lockToken: '00000000-0000-4000-8000-0000000000bb',
    };
    await expect(checkpoints.startStep(stolen, 1, 'next')).rejects.toThrow(
      LeaseLostError,
    );
    await expect(checkpoints.checkpoint(stolen, run, 'late')).rejects.toThrow(
      LeaseLostError,
    );
    for (const status of ['queued', 'done'] as const) {
      await owner.getRepository(Job).update(job.id, { status });
      await expect(checkpoints.startStep(job, 1, 'next')).rejects.toThrow(
        LeaseLostError,
      );
      await expect(checkpoints.checkpoint(job, run, 'late')).rejects.toThrow(
        LeaseLostError,
      );
    }
    expect(
      await owner.getRepository(StepRun).findBy({ executionId: execution.id }),
    ).toEqual([
      expect.objectContaining({ id: run.id, status: 'running', output: null }),
    ]);
    expect(
      await owner.getRepository(Job).findOneByOrFail({ id: job.id }),
    ).toMatchObject({ attempts: 1 });
  });

  it('wakes a delay step only once its wake-up time has come, otherwise parks the job again', async () => {
    const run = await checkpoints.startStep(job, 0, 'say');
    const future = new Date(Date.now() + 60_000);
    await owner.getRepository(StepRun).update(run.id, { wakeAt: future });
    const early = await checkpoints.wakeIfDue(
      job,
      { ...run, wakeAt: future },
      { waitedMs: 1 },
    );
    expect(early).toBeNull();
    expect(
      await owner.getRepository(Job).findOneByOrFail({ id: job.id }),
    ).toMatchObject({
      status: 'queued',
      lockToken: null,
      attempts: 0,
      runAt: future,
    });
    expect(
      await owner.getRepository(StepRun).findOneByOrFail({ id: run.id }),
    ).toMatchObject({ status: 'running', output: null });

    const past = new Date(Date.now() - 1_000);
    await owner.getRepository(StepRun).update(run.id, { wakeAt: past });
    await owner.getRepository(Job).update(job.id, {
      status: 'running',
      lockToken: job.lockToken,
      attempts: 1,
    });
    const due = await checkpoints.wakeIfDue(
      job,
      { ...run, wakeAt: past },
      { waitedMs: 1 },
    );
    expect(due).toMatchObject({ output: { waitedMs: 1 } });
    expect(
      await owner.getRepository(Job).findOneByOrFail({ id: job.id }),
    ).toMatchObject({ status: 'running', attempts: 0 });
  });

  it('a checkpoint racing the lease reaper ends either saved with the lease kept or reaped without the result', async () => {
    for (let i = 0; i < 30; i++) {
      await owner.getRepository(StepRun).delete({ executionId: execution.id });
      await owner.getRepository(Job).update(job.id, {
        status: 'running',
        lockToken: job.lockToken,
        attempts: 0,
        lockedUntil: new Date(Date.now() + 60_000),
      });
      const run = await checkpoints.startStep(job, 0, 'say');
      // Lease минув: reaper і чекпоінт того самого воркера змагаються за рядок задачі.
      await owner.getRepository(Job).update(job.id, {
        lockedUntil: new Date(Date.now() - 1_000),
      });
      const [saved, reaped] = await Promise.allSettled([
        checkpoints.checkpoint(job, run, i),
        queue.reapExpired(),
      ]);
      expect(reaped.status).toBe('fulfilled');
      const after = await owner
        .getRepository(Job)
        .findOneByOrFail({ id: job.id });
      const step = await owner
        .getRepository(StepRun)
        .findOneByOrFail({ id: run.id });
      if (saved.status === 'fulfilled') {
        // Чекпоінт заблокував задачу першим: результат є, лічильник обнулено. Reaper або
        // пропустив рядок (SKIP LOCKED), або після чекпоінта завершив виконання зі збереженого
        // результату — в обох випадках крок не втрачено й не повторено.
        expect(step).toMatchObject({ status: 'succeeded', output: i });
        if (after.status === 'running') expect(after.attempts).toBe(0);
        else
          expect(
            await owner
              .getRepository(Execution)
              .findOneByOrFail({ id: execution.id }),
          ).toMatchObject({ status: 'succeeded', output: i });
      } else {
        // Reaper забрав lease першим: чекпоінт нічого не записав.
        expect(saved.reason).toBeInstanceOf(LeaseLostError);
        expect(step).toMatchObject({ status: 'running', output: null });
        expect(after.lockToken).toBeNull();
      }
    }
  });
});
