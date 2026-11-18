import { ConfigService } from '@nestjs/config';
import { JobQueueService } from '../../src/engine/job-queue.service';
import { DataSource } from 'typeorm';
import { openTestDataSource, truncateAll } from '../helpers/db';

/**
 * Міграції, що перетворюють наявні дані (а не лише схему): БД відкочується до стану перед
 * міграцією, заповнюється даними в старому форматі, і міграція застосовується знову.
 */
describe('data migrations', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = await openTestDataSource();
  });

  afterAll(async () => {
    // Схема мусить лишитися повною для наступних тестів, навіть якщо тест упав посередині.
    await ds.runMigrations({ transaction: 'each' });
    await truncateAll(ds);
    await ds.destroy();
  });

  /** Відкочує міграції, доки не буде скасовано міграцію з назвою, що починається з `name`. */
  async function revertThrough(name: string): Promise<void> {
    for (;;) {
      const [last]: Array<{ name: string }> = await ds.query(
        `SELECT name FROM migrations ORDER BY id DESC LIMIT 1`,
      );
      await ds.undoLastMigration({ transaction: 'each' });
      if (last.name.startsWith(name)) return;
    }
  }

  it('StepCheckpoints keeps one step run per step: the successful one, counting the attempts', async () => {
    await truncateAll(ds);
    await revertThrough('StepCheckpoints');
    const executionId = '00000000-0000-4000-8000-000000000001';
    const rows: Array<[number, string, string, string]> = [
      [0, 'fetch', 'failed', '2026-01-01T00:00:01Z'],
      [0, 'fetch', 'succeeded', '2026-01-01T00:00:02Z'],
      [0, 'fetch', 'succeeded', '2026-01-01T00:00:05Z'],
      [1, 'send', 'failed', '2026-01-01T00:00:03Z'],
      [1, 'send', 'failed', '2026-01-01T00:00:04Z'],
    ];
    for (const [stepIndex, stepId, status, startedAt] of rows) {
      await ds.query(
        `INSERT INTO step_runs ("executionId", "stepIndex", "stepId", status, "startedAt")
         VALUES ($1, $2, $3, $4, $5)`,
        [executionId, stepIndex, stepId, status, startedAt],
      );
    }

    await ds.runMigrations({ transaction: 'each' });

    const after: Array<{
      stepIndex: number;
      status: string;
      attempts: number;
      startedAt: Date;
    }> = await ds.query(
      `SELECT "stepIndex", status, attempts, "startedAt" FROM step_runs ORDER BY "stepIndex"`,
    );
    expect(
      after.map((r) => [
        r.stepIndex,
        r.status,
        r.attempts,
        r.startedAt.toISOString(),
      ]),
    ).toEqual([
      [0, 'succeeded', 3, '2026-01-01T00:00:05.000Z'],
      [1, 'failed', 2, '2026-01-01T00:00:04.000Z'],
    ]);
  });

  it('recovers an expired legacy job with no token without rolling back its neighbors', async () => {
    await truncateAll(ds);
    await revertThrough('QueueLease');
    const [wf]: { id: string; tenantId: string }[] =
      await ds.query(`INSERT INTO workflows ("tenantId",name,steps)
      VALUES (gen_random_uuid(),'old','[{"id":"a","type":"log","message":"x"}]') RETURNING *`);
    const execs: { id: string }[] = await ds.query(
      `INSERT INTO executions ("tenantId","workflowId",status)
      SELECT $1,$2,'running' FROM generate_series(1,2) RETURNING id`,
      [wf.tenantId, wf.id],
    );
    for (const e of execs)
      await ds.query(
        `INSERT INTO jobs ("tenantId","executionId",status,attempts,"lockedUntil")
      VALUES ($1,$2,'running',1,now()-interval '1 second')`,
        [wf.tenantId, e.id],
      );
    await ds.query(
      `INSERT INTO step_runs ("executionId","stepIndex","stepId",status,output)
      VALUES ($1,0,'a','succeeded','42')`,
      [execs[0].id],
    );
    await ds.runMigrations({ transaction: 'each' });
    const queue = new JobQueueService(
      ds,
      new ConfigService({ JOB_BACKOFF_BASE_MS: 10, JOB_BACKOFF_MAX_MS: 100 }),
    );
    const recovered = await queue.reapExpired();
    expect(recovered.map((r) => r.outcome).sort()).toEqual(['done', 'retry']);
    expect(
      await ds.query('SELECT status,output FROM executions WHERE id=$1', [
        execs[0].id,
      ]),
    ).toEqual([{ status: 'succeeded', output: 42 }]);
  });

  it('closes a stale job while preserving the result already recorded by the old worker', async () => {
    await truncateAll(ds);
    await revertThrough('QueueLease');
    const [execution]: { id: string; tenantId: string }[] = await ds.query(
      `INSERT INTO executions ("tenantId", "workflowId", status, output, "finishedAt")
       VALUES (gen_random_uuid(), gen_random_uuid(), 'succeeded', '42', now()) RETURNING id, "tenantId"`,
    );
    await ds.query(
      `INSERT INTO jobs ("tenantId", "executionId", status, "lockedUntil")
       VALUES ($1, $2, 'running', now() - interval '1 minute')`,
      [execution.tenantId, execution.id],
    );
    await ds.runMigrations({ transaction: 'each' });
    expect(
      await ds.query(
        `SELECT e.status, e.output, j.status AS job, j."lockedUntil", j."finishedAt" = e."finishedAt" AS "sameFinish"
       FROM executions e JOIN jobs j ON j."executionId" = e.id WHERE e.id = $1`,
        [execution.id],
      ),
    ).toEqual([
      {
        status: 'succeeded',
        output: 42,
        job: 'done',
        lockedUntil: null,
        sameFinish: true,
      },
    ]);
  });

  it('keeps a modern first attempt on a backfilled version after a worker restart', async () => {
    await truncateAll(ds);
    await revertThrough('RecoverCheckpoints');
    const [v]: { id: string; tenantId: string; workflowId: string }[] =
      await ds.query(
        `INSERT INTO workflow_versions ("tenantId","workflowId",version,steps)
       VALUES (gen_random_uuid(),gen_random_uuid(),2,'[{"id":"send","type":"http","url":"https://example.org"}]')
       RETURNING *`,
      );
    const [e]: { id: string }[] = await ds.query(
      `INSERT INTO executions ("tenantId","workflowId","workflowVersionId",status)
       VALUES ($1,$2,$3,'running') RETURNING id`,
      [v.tenantId, v.workflowId, v.id],
    );
    await ds.query(
      `INSERT INTO jobs ("tenantId","executionId",status) VALUES ($1,$2,'queued')`,
      [v.tenantId, e.id],
    );
    const [step]: { idempotencyKey: string }[] = await ds.query(
      `INSERT INTO step_runs ("executionId","stepIndex","stepId",status) VALUES ($1,0,'send','running') RETURNING "idempotencyKey"`,
      [e.id],
    );
    await ds.runMigrations({ transaction: 'each' });
    expect(
      await ds.query(
        `SELECT e.status, e."workflowVersionId", j.status AS job, s."idempotencyKey" FROM executions e
       JOIN jobs j ON j."executionId"=e.id JOIN step_runs s ON s."executionId"=e.id WHERE e.id=$1`,
        [e.id],
      ),
    ).toEqual([
      {
        status: 'running',
        workflowVersionId: v.id,
        job: 'queued',
        idempotencyKey: step.idempotencyKey,
      },
    ]);
  });

  it.each([
    ['old', 'succeeded'],
    ['replacement', 'succeeded'],
    ['replacement', 'running'],
  ])(
    'stops an ambiguous migrated checkpoint with step id %s and status %s and preserves the recorded output',
    async (stepId, stepStatus) => {
      await truncateAll(ds);
      await revertThrough('QueueLease');
      const [wf]: { id: string; tenantId: string }[] =
        await ds.query(`INSERT INTO workflows ("tenantId",name,steps,version)
      VALUES (gen_random_uuid(),'edited','[{"id":"replacement","type":"http","url":"https://example.org"}]',2) RETURNING *`);
      const [e]: { id: string }[] = await ds.query(
        `INSERT INTO executions ("tenantId","workflowId",status) VALUES($1,$2,'running') RETURNING id`,
        [wf.tenantId, wf.id],
      );
      await ds.query(
        `INSERT INTO jobs ("tenantId","executionId") VALUES($1,$2)`,
        [wf.tenantId, e.id],
      );
      await ds.query(
        `INSERT INTO step_runs ("executionId","stepIndex","stepId",status,output) VALUES($1,0,$2,$3,'42')`,
        [e.id, stepId, stepStatus],
      );
      await ds.runMigrations({ transaction: 'each' });
      expect(
        await ds.query(
          `SELECT e.status,e."workflowVersionId",j.status AS job,s.output FROM executions e JOIN jobs j
      ON j."executionId"=e.id JOIN step_runs s ON s."executionId"=e.id WHERE e.id=$1`,
          [e.id],
        ),
      ).toEqual([
        {
          status: 'failed',
          workflowVersionId: null,
          job: 'failed',
          output: 42,
        },
      ]);
    },
  );

  it('WorkflowVersions snapshots existing workflows and finishes runs of deleted ones', async () => {
    await truncateAll(ds);
    await revertThrough('WorkflowVersions');
    const tenantId = '00000000-0000-4000-8000-0000000000aa';
    const deletedWf = '00000000-0000-4000-8000-0000000000dd';
    const [{ id: wfId }]: Array<{ id: string }> = await ds.query(
      `INSERT INTO workflows ("tenantId", name, steps, version)
       VALUES ($1, 'kept', '[{"id":"a","type":"log","message":"x"}]', 3) RETURNING id`,
      [tenantId],
    );
    const insertExecution = async (workflowId: string, status: string) => {
      const [{ id }]: Array<{ id: string }> = await ds.query(
        `INSERT INTO executions ("tenantId", "workflowId", status) VALUES ($1, $2, $3) RETURNING id`,
        [tenantId, workflowId, status],
      );
      await ds.query(
        `INSERT INTO jobs ("tenantId", "executionId", status) VALUES ($1, $2, $3)`,
        [tenantId, id, status === 'succeeded' ? 'done' : 'queued'],
      );
      return id;
    };
    const live = await insertExecution(wfId, 'pending');
    const orphan = await insertExecution(deletedWf, 'pending');
    const history = await insertExecution(deletedWf, 'succeeded');

    await ds.runMigrations({ transaction: 'each' });

    const versions: Array<{ id: string; version: number; steps: unknown }> =
      await ds.query(
        `SELECT id, version, steps FROM workflow_versions WHERE "workflowId" = $1`,
        [wfId],
      );
    expect(versions).toEqual([
      {
        id: expect.any(String) as string,
        version: 3,
        steps: [{ id: 'a', type: 'log', message: 'x' }],
      },
    ]);
    const state = async (id: string) => {
      const [row]: Array<{
        status: string;
        workflowVersionId: string | null;
        job: string;
      }> = await ds.query(
        `SELECT e.status, e."workflowVersionId", j.status AS job
           FROM executions e JOIN jobs j ON j."executionId" = e.id WHERE e.id = $1`,
        [id],
      );
      return row;
    };
    expect(await state(live)).toEqual({
      status: 'pending',
      workflowVersionId: versions[0].id,
      job: 'queued',
    });
    expect(await state(orphan)).toEqual({
      status: 'failed',
      workflowVersionId: null,
      job: 'failed',
    });
    expect(await state(history)).toEqual({
      status: 'succeeded',
      workflowVersionId: null,
      job: 'done',
    });
  });

  it('JobFinishedAt dates finished jobs by their execution, or by the job itself', async () => {
    await truncateAll(ds);
    await revertThrough('JobFinishedAt');
    const tenantId = '00000000-0000-4000-8000-0000000000aa';
    const [version]: { id: string; workflowId: string }[] = await ds.query(
      `INSERT INTO workflow_versions ("tenantId", "workflowId", version, steps)
       VALUES ($1, gen_random_uuid(), 1, '[]') RETURNING id, "workflowId"`,
      [tenantId],
    );
    const insert = async (
      jobStatus: string,
      executionFinishedAt: string | null,
      jobCreatedAt: string,
    ) => {
      const [{ id }]: Array<{ id: string }> = await ds.query(
        `INSERT INTO executions ("tenantId", "workflowId", "workflowVersionId", status, "finishedAt")
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [
          tenantId,
          version.workflowId,
          version.id,
          jobStatus === 'queued'
            ? 'pending'
            : jobStatus === 'done'
              ? 'succeeded'
              : 'failed',
          executionFinishedAt,
        ],
      );
      const [{ id: jobId }]: Array<{ id: string }> = await ds.query(
        `INSERT INTO jobs ("tenantId", "executionId", status, "createdAt")
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [tenantId, id, jobStatus, jobCreatedAt],
      );
      return jobId;
    };
    const done = await insert(
      'done',
      '2026-03-01T10:00:05Z',
      '2026-03-01T10:00:00Z',
    );
    const dead = await insert('dead', null, '2026-03-02T00:00:00Z');
    const queued = await insert('queued', null, '2026-03-03T00:00:00Z');

    await ds.runMigrations({ transaction: 'each' });

    const finishedAt = async (id: string) => {
      const [row]: Array<{ finishedAt: Date | null }> = await ds.query(
        `SELECT "finishedAt" FROM jobs WHERE id = $1`,
        [id],
      );
      return row.finishedAt?.toISOString() ?? null;
    };
    expect(await finishedAt(done)).toBe('2026-03-01T10:00:05.000Z');
    expect(await finishedAt(dead)).toBe('2026-03-02T00:00:00.000Z');
    expect(await finishedAt(queued)).toBeNull();
  });
});
