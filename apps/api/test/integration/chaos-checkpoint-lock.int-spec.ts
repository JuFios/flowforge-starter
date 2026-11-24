import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { checkpointWriteIsBlocked } from '../../scripts/chaos-checkpoint-lock';
import { CHECKPOINT_SQL } from '../../src/engine/checkpoint.service';
import { Job, StepRun } from '../../src/entities';
import {
  createExecution,
  createTenant,
  createWorkflow,
  openTestDataSource,
  truncateAll,
} from '../helpers/db';
import { testWorkerDatabaseUrl } from '../helpers/test-env';
import { waitFor } from '../helpers/wait-for';

describe('Postgres restart checkpoint barrier', () => {
  let owner: DataSource;
  let worker: DataSource;
  let job: Job;
  let step: StepRun;

  beforeAll(async () => {
    owner = await openTestDataSource();
    worker = await new DataSource({
      type: 'postgres',
      url: testWorkerDatabaseUrl(),
      connectTimeoutMS: 5_000,
      extra: { statement_timeout: 5_000 },
    }).initialize();
  });

  beforeEach(async () => {
    await truncateAll(owner);
    const { tenant } = await createTenant(owner);
    const execution = await createExecution(
      owner,
      await createWorkflow(owner, tenant.id),
    );
    job = await owner.getRepository(Job).save({
      tenantId: tenant.id,
      executionId: execution.id,
      status: 'running',
      lockToken: randomUUID(),
      lockedUntil: new Date(Date.now() + 60_000),
    });
    step = await owner.getRepository(StepRun).save({
      tenantId: tenant.id,
      executionId: execution.id,
      stepIndex: 0,
      stepId: 'charge',
    });
  });

  afterAll(async () => {
    await Promise.all([worker?.destroy(), owner?.destroy()]);
  });

  async function observeBlockedWrite(
    ds: DataSource,
    sql: string,
    args: unknown[],
    lock: 'row' | 'table' = 'row',
  ) {
    const gate = owner.createQueryRunner();
    const writer = ds.createQueryRunner();
    try {
      await gate.startTransaction();
      await gate.query("SET LOCAL statement_timeout = '5s'");
      if (lock === 'row')
        await gate.query('SELECT id FROM step_runs WHERE id = $1 FOR UPDATE', [
          step.id,
        ]);
      else await gate.query('LOCK TABLE step_runs IN ACCESS EXCLUSIVE MODE');
      const [{ pid: gatePid }] = await gate.manager.query<
        Array<{ pid: number }>
      >('SELECT pg_backend_pid() AS pid');

      await writer.startTransaction();
      await writer.query("SELECT set_config('app.tenant_id', $1, true)", [
        job.tenantId,
      ]);
      const [{ pid: writerPid }] = await writer.manager.query<
        Array<{ pid: number }>
      >('SELECT pg_backend_pid() AS pid');
      const [{ pid: unrelatedPid }] = await owner.query<Array<{ pid: number }>>(
        'SELECT pg_backend_pid() AS pid',
      );

      const write = Promise.allSettled([writer.query(sql, args)]);
      let observation: { onGate: boolean; onUnrelatedPid: boolean };
      let result: PromiseSettledResult<unknown>;
      try {
        await waitFor(
          'actual blocking of the write',
          async () => {
            const [{ waiting }] = await owner.query<
              Array<{ waiting: boolean }>
            >('SELECT $1 = ANY(pg_blocking_pids($2)) AS waiting', [
              gatePid,
              writerPid,
            ]);
            return waiting;
          },
          { timeoutMs: 3_000 },
        );
        observation = {
          onGate: await checkpointWriteIsBlocked(owner, gatePid),
          onUnrelatedPid: await checkpointWriteIsBlocked(owner, unrelatedPid),
        };
      } finally {
        await gate.rollbackTransaction();
        [result] = await write;
      }
      if (result.status === 'rejected') throw result.reason as unknown;
      return observation;
    } finally {
      try {
        if (gate.isTransactionActive) await gate.rollbackTransaction();
        if (writer.isTransactionActive) await writer.rollbackTransaction();
      } finally {
        await Promise.all([gate.release(), writer.release()]);
      }
    }
  }

  it('detects the actual CTE checkpoint waiting on the gate transaction', async () => {
    await expect(
      observeBlockedWrite(worker, CHECKPOINT_SQL, [
        job.id,
        job.tenantId,
        job.lockToken,
        step.id,
        JSON.stringify({ charged: true }),
      ]),
    ).resolves.toEqual({ onGate: true, onUnrelatedPid: false });
  });

  it('ignores an owner session waiting on the gate row', async () => {
    await expect(
      observeBlockedWrite(
        owner,
        "UPDATE step_runs SET status = 'succeeded' WHERE id = $1",
        [step.id],
      ),
    ).resolves.toMatchObject({ onGate: false });
  });

  it('ignores a worker waiting on a table lock instead of the gate row', async () => {
    await expect(
      observeBlockedWrite(
        worker,
        "UPDATE step_runs SET status = 'succeeded' WHERE id = $1",
        [step.id],
        'table',
      ),
    ).resolves.toMatchObject({ onGate: false });
  });
});
