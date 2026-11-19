import { ConfigService } from '@nestjs/config';
import { JobQueueService } from '../../src/engine/job-queue.service';
import { SystemDb } from '../../src/tenancy/system-db';
import { TenantDb } from '../../src/tenancy/tenant-db';
import { DataSource } from 'typeorm';
import { MIGRATIONS } from '../../src/database/migrations';
import { openTestDataSource, truncateAll } from '../helpers/db';
import { provisionTestDatabase } from '../helpers/test-provision';
import { clusterScopedName } from '../helpers/test-env';

/** Стороння роль сценаріїв «чужий член службової ролі» (спільна для кластера, тож з суфіксом прогону). */
const FOREIGN_ROLE = clusterScopedName('ff_foreign_test');

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
    // Схема мусить лишитися повною для наступних тестів, навіть якщо тест упав посередині. Дані
    // старих форматів (без тенантів) очищаються до того, як TenantIsolation перевірить цілісність.
    await truncateAll(ds);
    await ds.runMigrations({ transaction: 'each' });
    await provisionTestDatabase(ds);
    await truncateAll(ds);
    await ds.destroy();
  });

  /**
   * Застосовує міграції лише до `name` (не включно). Тести старих міграцій перевіряють їх на даних
   * своєї епохи — без тенантів і з довільними посиланнями, яких TenantIsolation далі не допускає
   * (її перевірку на таких даних покриває окремий тест нижче).
   */
  async function migrateBefore(name: string): Promise<void> {
    const until = MIGRATIONS.findIndex((m) => m.name.startsWith(name));
    if (until < 0) throw new Error(`unknown migration ${name}`);
    const partial = await new DataSource({
      ...ds.options,
      migrations: MIGRATIONS.slice(0, until),
    }).initialize();
    try {
      await partial.runMigrations({ transaction: 'each' });
    } finally {
      await partial.destroy();
    }
  }

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

    await migrateBefore('TenantIsolation');

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
    // Тест проходить усі міграції й запускає reaper, тож дані узгоджені з TenantIsolation: тенант
    // існує, задачі й кроки посилаються на його виконання.
    const [tenant]: { id: string }[] = await ds.query(
      `INSERT INTO tenants (name, "apiKeyHash", "webhookSecret") VALUES ('legacy', 'hash', 'secret') RETURNING id`,
    );
    const [wf]: { id: string; tenantId: string }[] = await ds.query(
      `INSERT INTO workflows ("tenantId",name,steps)
      VALUES ($1,'old','[{"id":"a","type":"log","message":"x"}]') RETURNING *`,
      [tenant.id],
    );
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
      new TenantDb(ds),
      new SystemDb(ds),
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
    await migrateBefore('TenantIsolation');
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
    await migrateBefore('TenantIsolation');
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
      await migrateBefore('TenantIsolation');
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

    await migrateBefore('TenantIsolation');

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

    await migrateBefore('TenantIsolation');

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

  /** Повна схема (попередній тест міг лишити її до TenantIsolation), потім відкат TenantIsolation. */
  async function beforeTenantIsolation(): Promise<void> {
    await truncateAll(ds);
    await ds.runMigrations({ transaction: 'each' });
    await revertThrough('TenantIsolation');
  }

  it('reconciles a stale cached quota on upgrade and preserves tenant overrides', async () => {
    await truncateAll(ds);
    await ds.runMigrations({ transaction: 'each' });
    await revertThrough('TenantQuotaConsistency');
    await ds.query(`INSERT INTO tenants(name,"apiKeyHash","webhookSecret","maxConcurrentExecutions")
      VALUES ('default','default','fixture',NULL),('override','override','fixture',3)`);
    await ds.query('UPDATE limit_defaults SET "maxRunning"=1');
    await ds.query('UPDATE tenant_usage SET "maxRunning"=10');
    await ds.runMigrations({ transaction: 'each' });
    expect(
      await ds.query('SELECT "maxRunning" FROM tenant_usage ORDER BY 1'),
    ).toEqual([{ maxRunning: 1 }, { maxRunning: 3 }]);
  });

  it('TenantUsage backfills the usage of every tenant from its jobs, and claiming works right after', async () => {
    await truncateAll(ds);
    // Схема могла лишитися частковою після попередніх тестів: спершу повна, потім — до TenantUsage.
    await ds.runMigrations({ transaction: 'each' });
    await revertThrough('TenantUsage');
    const [a, b]: Array<{ id: string }> = await ds.query(
      `INSERT INTO tenants (name, "apiKeyHash", "webhookSecret")
       VALUES ('a', 'hash-a', 's'), ('b', 'hash-b', 's') RETURNING id`,
    );
    // A: 3 готові й 1 майбутня в черзі, 2 у роботі, 1 завершена; B — без задач.
    const jobs: Array<[string, string]> = [
      ['queued', "now() - interval '3 minutes'"],
      ['queued', "now() - interval '2 minutes'"],
      ['queued', "now() - interval '1 minute'"],
      ['queued', "now() + interval '1 hour'"],
      ['running', 'now()'],
      ['running', 'now()'],
      ['done', 'now()'],
    ];
    for (const [status, runAt] of jobs) {
      const [e]: Array<{ id: string }> = await ds.query(
        `INSERT INTO executions ("tenantId", "workflowId", status, "finishedAt")
         VALUES ($1, gen_random_uuid(), 'succeeded', now()) RETURNING id`,
        [a.id],
      );
      await ds.query(
        `INSERT INTO jobs ("tenantId", "executionId", status, "runAt", "lockToken", "lockedUntil", "finishedAt")
         VALUES ($1, $2, $3::text, ${runAt},
                 CASE WHEN $3::text = 'running' THEN gen_random_uuid() END,
                 CASE WHEN $3::text = 'running' THEN now() + interval '1 hour' END,
                 CASE WHEN $3::text = 'done' THEN now() END)`,
        [a.id, e.id, status],
      );
    }

    await ds.runMigrations({ transaction: 'each' });

    const usage: Array<Record<string, unknown>> = await ds.query(
      `SELECT u."tenantId", u.queued, u.running, u.ready, u."maxRunning", u."maxQueueSize",
              u."nextRunAt" = (SELECT min("runAt") FROM jobs
                                WHERE "tenantId" = u."tenantId" AND status = 'queued') AS "exactNext",
              u."nextRunAt" IS NULL AS "noNext"
         FROM tenant_usage u ORDER BY u.queued DESC`,
    );
    expect(usage).toEqual([
      {
        tenantId: a.id,
        queued: 4,
        running: 2,
        ready: true,
        maxRunning: 10,
        maxQueueSize: 100_000,
        exactNext: true,
        noNext: false,
      },
      {
        tenantId: b.id,
        queued: 0,
        running: 0,
        ready: false,
        maxRunning: 10,
        maxQueueSize: 100_000,
        exactNext: null,
        noNext: true,
      },
    ]);
    // Облік узгоджений з задачами: перше ж захоплення бере найранішу готову задачу A.
    const [claimed]: Array<{ status: string; tenantId: string }> =
      await ds.query(
        `SELECT (r.job).status, (r.job)."tenantId" FROM claim_job('upgrade', 30000) r`,
      );
    expect(claimed).toEqual({ status: 'running', tenantId: a.id });
  });

  it('TenantIsolation gives steps their tenant and keeps history: deleted workflows, runs without a snapshot', async () => {
    await beforeTenantIsolation();
    const [tenant]: { id: string }[] = await ds.query(
      `INSERT INTO tenants (name, "apiKeyHash", "webhookSecret") VALUES ('a', 'hash-a', 's') RETURNING id`,
    );
    // Історичне завершене виконання без знімку (дозволене CHK_executions_version_snapshot) і
    // виконання видаленого workflow (на workflows FK навмисно немає).
    const [legacy]: { id: string }[] = await ds.query(
      `INSERT INTO executions ("tenantId", "workflowId", status, "finishedAt")
       VALUES ($1, gen_random_uuid(), 'failed', now()) RETURNING id`,
      [tenant.id],
    );
    const [version]: { id: string }[] = await ds.query(
      `INSERT INTO workflow_versions ("tenantId", "workflowId", version, steps)
       VALUES ($1, gen_random_uuid(), 1, '[{"id":"say","type":"log","message":"x"}]') RETURNING id`,
      [tenant.id],
    );
    const [current]: { id: string }[] = await ds.query(
      `INSERT INTO executions ("tenantId", "workflowId", "workflowVersionId", status)
       VALUES ($1, gen_random_uuid(), $2, 'running') RETURNING id`,
      [tenant.id, version.id],
    );
    for (const e of [legacy, current]) {
      await ds.query(
        `INSERT INTO step_runs ("executionId", "stepIndex", "stepId", status) VALUES ($1, 0, 'say', 'succeeded')`,
        [e.id],
      );
      await ds.query(
        `INSERT INTO jobs ("tenantId", "executionId", status) VALUES ($1, $2, 'done')`,
        [tenant.id, e.id],
      );
    }

    await ds.runMigrations({ transaction: 'each' });

    expect(
      await ds.query(
        `SELECT "executionId", "tenantId" FROM step_runs ORDER BY "executionId"`,
      ),
    ).toEqual(
      [legacy.id, current.id]
        .sort()
        .map((executionId) => ({ executionId, tenantId: tenant.id })),
    );
    expect(await ds.query(`SELECT count(*)::int AS n FROM executions`)).toEqual(
      [{ n: 2 }],
    );
  });

  type Orphan = (ids: {
    otherTenant: string;
    execution: string;
  }) => [string, unknown[]];
  it.each<[string, Orphan, string]>([
    [
      'a job of another tenant than its execution',
      ({ otherTenant, execution }) => [
        `INSERT INTO jobs ("tenantId", "executionId", status) VALUES ($1, $2, 'done')`,
        [otherTenant, execution],
      ],
      'jobs whose tenant differs from their execution',
    ],
    [
      'a step of a missing execution',
      () => [
        `INSERT INTO step_runs ("executionId", "stepIndex", "stepId", status)
         VALUES (gen_random_uuid(), 0, 'say', 'failed')`,
        [],
      ],
      'step_runs without their execution',
    ],
    [
      'a workflow of an unknown tenant',
      () => [
        `INSERT INTO workflows ("tenantId", name, steps) VALUES (gen_random_uuid(), 'w', '[]')`,
        [],
      ],
      'workflows of an unknown tenant',
    ],
  ])(
    'TenantIsolation refuses to run with %s and changes nothing',
    async (_case, orphan, reason) => {
      await beforeTenantIsolation();
      const tenants: { id: string }[] = await ds.query(
        `INSERT INTO tenants (name, "apiKeyHash", "webhookSecret")
         VALUES ('a', 'hash-a', 's'), ('b', 'hash-b', 's') RETURNING id`,
      );
      const [execution]: { id: string }[] = await ds.query(
        `INSERT INTO executions ("tenantId", "workflowId", status, "finishedAt")
         VALUES ($1, gen_random_uuid(), 'succeeded', now()) RETURNING id`,
        [tenants[0].id],
      );
      const [sql, params] = orphan({
        otherTenant: tenants[1].id,
        execution: execution.id,
      });
      await ds.query(sql, params);

      await expect(ds.runMigrations({ transaction: 'each' })).rejects.toThrow(
        reason,
      );
      // Міграція в транзакції: колонки step_runs.tenantId так і не з'явилось.
      expect(
        await ds.query(
          `SELECT 1 FROM information_schema.columns
            WHERE table_name = 'step_runs' AND column_name = 'tenantId'`,
        ),
      ).toHaveLength(0);
      await truncateAll(ds);
      await ds.runMigrations({ transaction: 'each' });
    },
  );

  // Службові ролі спільні для кластера: їх міг заздалегідь створити чи «засвоїти» хтось інший
  // (на PG16 творець ролі з CREATEROLE отримує на неї ADMIN OPTION).
  it.each<[string, string[], string]>([
    [
      'a role that can act as flowforge_system',
      [
        `CREATE ROLE ${FOREIGN_ROLE} NOLOGIN`,
        `GRANT flowforge_system TO ${FOREIGN_ROLE} WITH ADMIN OPTION`,
      ],
      `unexpected members of flowforge_system: ${FOREIGN_ROLE}`,
    ],
    [
      'an administrator of the API group',
      [
        `CREATE ROLE ${FOREIGN_ROLE} LOGIN`,
        `GRANT flowforge_api_role TO ${FOREIGN_ROLE} WITH ADMIN OPTION`,
      ],
      `unexpected members of flowforge_api_role: ${FOREIGN_ROLE}`,
    ],
    [
      'a group nested into the worker group',
      [
        `CREATE ROLE ${FOREIGN_ROLE} NOLOGIN`,
        `GRANT flowforge_worker_role TO ${FOREIGN_ROLE}`,
      ],
      `unexpected members of flowforge_worker_role: ${FOREIGN_ROLE}`,
    ],
    [
      'an object already owned by flowforge_system',
      [
        'CREATE VIEW ff_trap_test AS SELECT 1 AS x',
        'ALTER VIEW ff_trap_test OWNER TO flowforge_system',
      ],
      'flowforge_system already owns objects in this database',
    ],
  ])(
    'TenantIsolation refuses to configure the roles with %s and changes nothing',
    async (_case, setup, reason) => {
      await beforeTenantIsolation();
      try {
        for (const sql of setup) await ds.query(sql);
        await expect(ds.runMigrations({ transaction: 'each' })).rejects.toThrow(
          reason,
        );
        expect(
          await ds.query(
            `SELECT 1 FROM information_schema.columns
              WHERE table_name = 'step_runs' AND column_name = 'tenantId'`,
          ),
        ).toHaveLength(0);
      } finally {
        await ds.query('DROP VIEW IF EXISTS ff_trap_test');
        await ds.query(`DROP ROLE IF EXISTS ${FOREIGN_ROLE}`);
        await ds.runMigrations({ transaction: 'each' });
      }
    },
  );

  it('upgrades in-flight deliveries, hints, short schedules and unfinished executions from PR 5', async () => {
    await truncateAll(ds);
    await revertThrough('SerializeOutbox');
    const [{ id: tenantId }] = await ds.query<Array<{ id: string }>>(
      `INSERT INTO tenants(name,"apiKeyHash","webhookSecret") VALUES ('upgrade','upgrade-hash','old') RETURNING id`,
    );
    const [{ id: wf }] = await ds.query<Array<{ id: string }>>(
      `INSERT INTO workflows("tenantId",name,steps,cron,"scheduleCursor","nextFireAt") VALUES ($1,'legacy','[]','* *',now(),now()+interval '1 year') RETURNING id`,
      [tenantId],
    );
    const [{ id: version }] = await ds.query<Array<{ id: string }>>(
      `INSERT INTO workflow_versions ("workflowId","tenantId",version,steps) VALUES ($1,$2,1,'[]') RETURNING id`,
      [wf, tenantId],
    );
    const [{ id: execution }] = await ds.query<Array<{ id: string }>>(
      `INSERT INTO executions("tenantId","workflowId","workflowVersionId") VALUES ($1,$2,$3) RETURNING id`,
      [tenantId, wf, version],
    );
    await ds.query(
      `INSERT INTO notification_settings ("tenantId",url,secret,"dueAt") VALUES ($1,'https://example.org',repeat('a',64),NULL)`,
      [tenantId],
    );
    await ds.query(
      `INSERT INTO outbox_events ("tenantId","executionId",sequence,type,payload,status,"leaseToken","leaseUntil")
      VALUES ($1,gen_random_uuid(),1,'execution.failed','old bytes','sending',gen_random_uuid(),now()+interval '1 hour'),
             ($1,gen_random_uuid(),1,'execution.failed','pending bytes','pending',NULL,NULL)`,
      [tenantId],
    );
    const events = () =>
      ds.query<unknown[]>(
        'SELECT id,status,payload,"leaseToken","leaseUntil","nextAttemptAt" FROM outbox_events ORDER BY id',
      );
    const settings = () =>
      ds.query<unknown[]>(
        'SELECT url,enabled,revision,"secretKeyId",secret FROM notification_settings',
      );
    const before = await events(),
      keys = await settings();
    await ds.runMigrations({ transaction: 'each' });
    expect(await events()).toEqual(before);
    expect(await settings()).toEqual(keys);
    expect(
      await ds.query(
        `SELECT "dueAt"="nextAttemptAt" AS correct FROM notification_settings JOIN outbox_events USING ("tenantId") WHERE status='pending'`,
      ),
    ).toEqual([{ correct: true }]);
    expect(
      await ds.query(
        'SELECT cron,"nextFireAt","scheduleError" FROM workflows WHERE id=$1',
        [wf],
      ),
    ).toEqual([
      {
        cron: '* *',
        nextFireAt: null,
        scheduleError: expect.any(String) as unknown,
      },
    ]);
    await ds.query("UPDATE executions SET status='succeeded' WHERE id=$1", [
      execution,
    ]);
    expect(
      await ds.query(
        'SELECT sequence,status FROM outbox_events WHERE "executionId"=$1',
        [execution],
      ),
    ).toEqual([{ sequence: 1, status: 'pending' }]);
    await truncateAll(ds);
  });

  it('ScheduleProgress and NotificationOutbox upgrade stored schedules and executions without a flood or a duplicate', async () => {
    await truncateAll(ds);
    await revertThrough('ScheduleProgress');
    const [tenant]: Array<{ id: string }> = await ds.query(
      `INSERT INTO tenants (name, "apiKeyHash", "webhookSecret") VALUES ('old', 'h-upgrade', 's') RETURNING id`,
    );
    const [wf]: Array<{ id: string }> = await ds.query(
      `INSERT INTO workflows ("tenantId", name, steps, cron, timezone)
       VALUES ($1, 'nightly', '[]', '* * * * * *', 'Europe/Kyiv') RETURNING id`,
      [tenant.id],
    );
    const [version]: Array<{ id: string }> = await ds.query(
      `INSERT INTO workflow_versions ("workflowId", "tenantId", version, steps)
       VALUES ($1, $2, 1, '[]') RETURNING id`,
      [wf.id, tenant.id],
    );
    // Спрацювання, створене попередньою версією, — момент секунду тому.
    const [{ at }]: Array<{ at: Date }> = await ds.query(
      `SELECT date_trunc('second', now()) - interval '1 second' AS at`,
    );
    const [fired]: Array<{ id: string }> = await ds.query(
      `INSERT INTO executions ("tenantId", "workflowId", "workflowVersionId", trigger, status, "scheduledAt", "finishedAt")
       VALUES ($1, $2, $3, 'cron', 'succeeded', $4, now()) RETURNING id`,
      [tenant.id, wf.id, version.id, at],
    );
    const [failed]: Array<{ id: string }> = await ds.query(
      `INSERT INTO executions ("tenantId", "workflowId", "workflowVersionId", trigger, status, error, "finishedAt")
       VALUES ($1, $2, $3, 'api', 'failed', 'old failure', now()) RETURNING id`,
      [tenant.id, wf.id, version.id],
    );
    await ds.runMigrations({ transaction: 'each' });

    const [upgraded]: Array<{
      cursor: Date;
      next: Date | null;
      policy: string;
    }> = await ds.query(
      `SELECT "scheduleCursor" AS cursor, "nextFireAt" AS next, "missedRunPolicy" AS policy
         FROM workflows WHERE id = $1`,
      [wf.id],
    );
    // Відлік — з моменту оновлення: момент, уже створений попередньою версією, не повторюється, а
    // моменти до оновлення не наздоганяються.
    expect(upgraded.policy).toBe('run_once');
    expect(upgraded.cursor.getTime()).toBeGreaterThanOrEqual(at.getTime());
    expect(upgraded.next).not.toBeNull();
    const cycles: Array<{ id: string; terminalCycles: number }> =
      await ds.query(
        'SELECT id, "terminalCycles" FROM executions WHERE id = ANY($1) ORDER BY id',
        [[fired.id, failed.id]],
      );
    expect(cycles.map((c) => c.terminalCycles)).toEqual([1, 1]);
    // Старі завершення сповіщень не створюють.
    expect(await ds.query('SELECT 1 FROM outbox_events')).toEqual([]);
    // Після налаштування сповіщень повтор старого виконання — другий цикл, подія з sequence 2.
    await ds.query(
      `INSERT INTO notification_settings ("tenantId", url, secret) VALUES ($1, 'https://receiver.example/hook', $2)`,
      [tenant.id, 'a'.repeat(64)],
    );
    await ds.query(
      `UPDATE executions SET status = 'pending', error = NULL WHERE id = $1`,
      [failed.id],
    );
    await ds.query(
      `UPDATE executions SET status = 'succeeded', "finishedAt" = now() WHERE id = $1`,
      [failed.id],
    );
    const events: Array<{ sequence: number; type: string }> = await ds.query(
      'SELECT sequence, type FROM outbox_events',
    );
    expect(events).toEqual([{ sequence: 2, type: 'execution.succeeded' }]);
    await truncateAll(ds);
  });
});
