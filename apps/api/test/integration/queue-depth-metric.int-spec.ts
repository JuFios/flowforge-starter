import { DataSource } from 'typeorm';
import { WorkerModule } from '../../src/app.module';
import { RunningApp, startApp } from '../helpers/app';
import {
  createTenant,
  createWorkflow,
  openTestDataSource,
  truncateAll,
} from '../helpers/db';
import { sleep } from '../helpers/queue';

/** Знімок глибини кешується на 5 с: тест чекає трохи довше, щоб побачити новий стан. */
const CACHE_EXPIRY_MS = 5_200;

/**
 * Метрика глибини черги за тенантом (ТЗ, розд. «Метрики»): серія `queued` і `running` для кожного
 * тенанта з незавершеними задачами — точні значення з обліку; тенант, що спорожнів, зникає;
 * помилка читання — лічильник, а не застарілі значення.
 */
describe('queue depth per tenant on the worker /metrics endpoint', () => {
  let owner: DataSource;
  let worker: RunningApp;

  beforeAll(async () => {
    owner = await openTestDataSource();
    await truncateAll(owner);
    worker = await startApp(WorkerModule);
  });

  afterAll(async () => {
    await worker.close();
    await truncateAll(owner);
    await owner.destroy();
  });

  /** Значення серій глибини: tenantId → { queued, running }. */
  async function depth(): Promise<{
    series: Map<string, Record<string, number>>;
    errors: number;
  }> {
    const text = await (await fetch(`${worker.baseUrl}/metrics`)).text();
    const series = new Map<string, Record<string, number>>();
    for (const [, labels, value] of text.matchAll(
      /^flowforge_queue_depth\{([^}]*)\} (\S+)$/gm,
    )) {
      const tenant = /tenant_id="([^"]+)"/.exec(labels)![1];
      const state = /state="([^"]+)"/.exec(labels)![1];
      series.set(tenant, { ...series.get(tenant), [state]: Number(value) });
    }
    const errors = Number(
      /^flowforge_queue_depth_collect_errors_total (\S+)$/m.exec(text)?.[1] ??
        NaN,
    );
    return { series, errors };
  }

  it('reports every tenant with unfinished jobs exactly, drops emptied tenants and counts read errors', async () => {
    // 60 тенантів: у i-го — i + 1 задача в черзі, у перших десяти ще й одна в роботі.
    const tenants: string[] = [];
    for (let i = 0; i < 60; i++) {
      const { tenant } = await createTenant(owner, `d${i}`);
      const wf = await createWorkflow(owner, tenant.id, `d${i}`);
      await owner.query(
        `WITH v AS (SELECT id FROM workflow_versions WHERE "workflowId" = $2),
              e AS (INSERT INTO executions ("tenantId", "workflowId", "workflowVersionId")
                    SELECT $1, $2, v.id FROM generate_series(1, $3) g, v RETURNING id)
         INSERT INTO jobs ("tenantId", "executionId", status, "lockToken", "lockedUntil")
         SELECT $1, e.id,
                CASE WHEN row_number() OVER () = 1 AND $4 THEN 'running' ELSE 'queued' END,
                CASE WHEN row_number() OVER () = 1 AND $4 THEN gen_random_uuid() END,
                CASE WHEN row_number() OVER () = 1 AND $4 THEN now() + interval '1 hour' END
           FROM e`,
        [tenant.id, wf.id, i + 1 + (i < 10 ? 1 : 0), i < 10],
      );
      tenants.push(tenant.id);
    }
    // Тенант без задач серії не має.
    const { tenant: idle } = await createTenant(owner, 'idle');

    const first = await depth();
    expect(first.series.size).toBe(60);
    for (const [i, id] of tenants.entries())
      expect(first.series.get(id)).toEqual({
        queued: i + 1,
        running: i < 10 ? 1 : 0,
      });
    expect(first.series.has(idle.id)).toBe(false);
    expect(first.errors).toBe(0);

    // Тенант 0 спорожнів: його серії зникають.
    await owner.query(
      `UPDATE jobs SET status = 'done', "finishedAt" = now(), "lockToken" = NULL
        WHERE "tenantId" = $1`,
      [tenants[0]],
    );
    await sleep(CACHE_EXPIRY_MS);
    const second = await depth();
    expect(second.series.has(tenants[0])).toBe(false);
    expect(second.series.size).toBe(59);

    // Облік недоступний: жодних застарілих значень, лише лічильник помилок.
    await owner.query(
      `ALTER FUNCTION queue_depth_by_tenant() RENAME TO queue_depth_by_tenant_off`,
    );
    try {
      await sleep(CACHE_EXPIRY_MS);
      const failed = await depth();
      expect(failed.series.size).toBe(0);
      expect(failed.errors).toBe(1);
    } finally {
      await owner.query(
        `ALTER FUNCTION queue_depth_by_tenant_off() RENAME TO queue_depth_by_tenant`,
      );
    }
    expect((await depth()).series.size).toBe(59);
  });
});
