import { DataSource } from 'typeorm';
import { WorkerModule } from '../../src/app.module';
import { Execution, WorkflowVersion } from '../../src/entities';
import { SystemDb } from '../../src/tenancy/system-db';
import { RunningApp, startApp } from '../helpers/app';
import {
  createExecution,
  createTenant,
  createWorkflow,
  openTestDataSource,
  truncateAll,
} from '../helpers/db';
import { stopSchedulerTimer, tenantCall } from '../helpers/schedule';
import { waitFor } from '../helpers/wait-for';

describe('workflow version cleanup', () => {
  let ds: DataSource;
  let api: RunningApp;
  let worker: RunningApp;
  let system: SystemDb;

  beforeAll(async () => {
    ds = await openTestDataSource();
    api = await startApp();
    stopSchedulerTimer(api);
    worker = await startApp(WorkerModule);
    system = worker.app.get(SystemDb);
  });
  beforeEach(async () => {
    await truncateAll(ds);
    await ds.query(
      'UPDATE workflow_version_cleanup SET cursor_id=NULL,end_id=NULL,finished_at=NULL',
    );
  });
  afterAll(async () => {
    await worker.close();
    await api.close();
    await truncateAll(ds);
    await ds.destroy();
  });

  it('keeps a deleted workflow version until the last execution referencing it expires', async () => {
    const { tenant, apiKey } = await createTenant(ds);
    const workflow = await createWorkflow(ds, tenant.id);
    const e = await createExecution(ds, workflow, {
      status: 'succeeded',
      finishedAt: new Date('2024-01-01T00:00:00Z'),
    });
    await ds.getRepository(WorkflowVersion).insert({
      workflowId: workflow.id,
      tenantId: tenant.id,
      version: 2,
      steps: workflow.steps,
    });
    const disabled = await createWorkflow(ds, tenant.id);
    await ds.query('UPDATE workflows SET enabled=false WHERE id=$1', [
      disabled.id,
    ]);
    const removed = await tenantCall(
      api,
      apiKey,
      'DELETE',
      `/workflows/${workflow.id}`,
    );
    expect(removed.status).toBe(204);
    expect(await system.purgeWorkflowVersions()).toEqual({
      deleted: 1,
      more: false,
    });
    expect(
      await ds
        .getRepository(WorkflowVersion)
        .findOneBy({ id: e.workflowVersionId! }),
    ).not.toBeNull();
    expect(await system.purgeExecutionHistory(1, 10)).toBe(1);
    expect(await system.purgeWorkflowVersions()).toEqual({
      deleted: 1,
      more: false,
    });
    expect(await ds.getRepository(WorkflowVersion).find()).toEqual([
      expect.objectContaining({ workflowId: disabled.id, version: 1 }),
    ]);
  });

  it('bounds each scan, skips locked rows and resumes after the cursor across connections', async () => {
    const { tenant } = await createTenant(ds);
    await ds.query(
      `
      INSERT INTO workflow_versions ("workflowId","tenantId",version,steps)
      SELECT gen_random_uuid(),$1,1,'[]'::jsonb FROM generate_series(1,505)
    `,
      [tenant.id],
    );
    const tx = ds.createQueryRunner();
    await tx.connect();
    await tx.startTransaction();
    try {
      const rolledBack = (await tx.query(
        'SELECT * FROM purge_workflow_versions(0)',
      )) as Array<{
        deleted: number;
        more: boolean;
      }>;
      expect(rolledBack[0]).toEqual({ deleted: 500, more: true });
      await tx.rollbackTransaction();
      expect(await ds.getRepository(WorkflowVersion).count()).toBe(505);
      await tx.startTransaction();
      await tx.query(
        'SELECT id FROM workflow_versions ORDER BY id LIMIT 1 FOR UPDATE',
      );
      expect(await system.purgeWorkflowVersions()).toEqual({
        deleted: 499,
        more: true,
      });
      const peer = await startApp(WorkerModule);
      try {
        expect(await peer.app.get(SystemDb).purgeWorkflowVersions()).toEqual({
          deleted: 5,
          more: false,
        });
      } finally {
        await peer.close();
      }
      expect(await ds.getRepository(WorkflowVersion).count()).toBe(1);
    } finally {
      await tx.rollbackTransaction();
      await tx.release();
    }
    const results = await Promise.all([
      system.purgeWorkflowVersions(),
      system.purgeWorkflowVersions(),
    ]);
    expect(results.reduce((sum, row) => sum + row.deleted, 0)).toBe(1);
    expect(await ds.getRepository(WorkflowVersion).count()).toBe(0);
  });

  it('starts no new pass until the gap after the last one, even for a worker that took part in it', async () => {
    const { tenant } = await createTenant(ds);
    const orphans = (count: number) =>
      ds.query(
        `INSERT INTO workflow_versions ("workflowId","tenantId",version,steps)
         SELECT gen_random_uuid(),$1,1,'[]'::jsonb FROM generate_series(1,$2)`,
        [tenant.id, count],
      );
    await orphans(505);
    const peer = await startApp(WorkerModule);
    try {
      const other = peer.app.get(SystemDb);
      const gap = 60_000;
      // Два воркери ділять один прохід; останню сторінку забирає другий.
      expect(await system.purgeWorkflowVersions(gap)).toEqual({
        deleted: 500,
        more: true,
      });
      expect(await other.purgeWorkflowVersions(gap)).toEqual({
        deleted: 5,
        more: false,
      });
      // Перший воркер востаннє бачив `more: true`; його наступний виклик не починає новий прохід.
      await orphans(3);
      expect(await system.purgeWorkflowVersions(gap)).toEqual({
        deleted: 0,
        more: false,
      });
      expect(await other.purgeWorkflowVersions(gap)).toEqual({
        deleted: 0,
        more: false,
      });
      expect(await ds.getRepository(WorkflowVersion).count()).toBe(3);
      // Після паузи (тут — нульової) новий прохід прибирає нові версії без посилань.
      expect(await system.purgeWorkflowVersions(0)).toEqual({
        deleted: 3,
        more: false,
      });
      await expect(system.purgeWorkflowVersions(-1)).rejects.toThrow(
        /minimum gap between cleanup passes/,
      );
    } finally {
      await peer.close();
    }
  });

  it('preserves versions needed by a launch and edit waiting on the workflow row', async () => {
    const { tenant, apiKey } = await createTenant(ds);
    const wf = await createWorkflow(ds, tenant.id);
    const tx = ds.createQueryRunner();
    await tx.connect();
    await tx.startTransaction();
    let run: Promise<Response> | undefined;
    let edit: Promise<Response> | undefined;
    try {
      const sessions = (await tx.query(
        'SELECT pg_backend_pid() AS pid',
      )) as Array<{ pid: number }>;
      const pid = sessions[0].pid;
      await tx.query('SELECT id FROM workflows WHERE id=$1 FOR UPDATE', [
        wf.id,
      ]);
      run = tenantCall(api, apiKey, 'POST', `/workflows/${wf.id}/run`, {});
      edit = tenantCall(api, apiKey, 'PATCH', `/workflows/${wf.id}`, {
        steps: [{ id: 'next', type: 'log', message: 'edited' }],
      });
      await waitFor(
        'launch and edit to contend for the workflow row',
        async () => {
          const [{ waiting }]: [{ waiting: number }] = await ds.query(
            `SELECT count(*)::int AS waiting FROM pg_stat_activity a
           WHERE a.query LIKE '%workflows%FOR %' AND a.datname=current_database()
             AND ($1=ANY(pg_blocking_pids(a.pid)) OR EXISTS (
               SELECT FROM pg_stat_activity b WHERE b.pid=ANY(pg_blocking_pids(a.pid))
                  AND $1=ANY(pg_blocking_pids(b.pid))))`,
            [pid],
          );
          return waiting >= 2;
        },
      );
      expect(await system.purgeWorkflowVersions()).toEqual({
        deleted: 0,
        more: false,
      });
    } finally {
      await tx.rollbackTransaction();
      await tx.release();
      await Promise.allSettled([run, edit]);
    }
    expect((await run)?.status).toBe(201);
    expect((await edit)?.status).toBe(200);
    await system.purgeWorkflowVersions();
    const executions = await ds
      .getRepository(Execution)
      .findBy({ tenantId: tenant.id });
    expect(executions).toHaveLength(1);
    const versions = await ds
      .getRepository(WorkflowVersion)
      .findBy({ workflowId: wf.id });
    expect(versions.map((v) => v.id)).toContain(
      executions[0].workflowVersionId,
    );
    expect(versions.map((v) => v.version)).toContain(2);
  });
});
