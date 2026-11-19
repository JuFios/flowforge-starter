import { DataSource } from 'typeorm';
import { createTenant, openTestDataSource, truncateAll } from '../helpers/db';

interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  Plans?: PlanNode[];
}

function nodes(root: PlanNode): PlanNode[] {
  return [root, ...(root.Plans ?? []).flatMap(nodes)];
}

/**
 * Плани запитів планувальника й outbox (ТЗ 5, README «Індекси і плани запитів»): на даних, де
 * послідовне читання було б дорожчим за індекс, кожен запит гарячого шляху йде своїм індексом.
 */
describe('scheduler and outbox query plans', () => {
  let ds: DataSource;
  let tenantId: string;

  beforeAll(async () => {
    ds = await openTestDataSource();
    await truncateAll(ds);
    ({
      tenant: { id: tenantId },
    } = await createTenant(ds));
    // 20 000 розкладів, належний — один із тисячі; 50 000 подій, недоставлені — одиниці.
    await ds.query(
      `INSERT INTO workflows("tenantId", name, steps, cron, "nextFireAt")
       SELECT $1, 'w', '[]', '0 * * * *',
              CASE WHEN g % 1000 = 0 THEN now() - interval '1 second' ELSE now() + interval '1 hour' END
         FROM generate_series(1, 20000) g`,
      [tenantId],
    );
    await ds.query(
      `INSERT INTO notification_settings ("tenantId", url, secret, "dueAt")
       VALUES ($1, 'https://receiver.example/hook', $2, now())`,
      [tenantId, 'a'.repeat(64)],
    );
    await ds.query(
      `INSERT INTO outbox_events ("tenantId", "executionId", sequence, type, payload, status,
                                  "deliveredAt", "leaseToken", "leaseUntil")
       SELECT $1, gen_random_uuid(), 1, 'execution.succeeded', '{}',
              CASE WHEN g % 5000 = 0 THEN 'pending' WHEN g % 5000 = 1 THEN 'sending' ELSE 'delivered' END,
              CASE WHEN g % 5000 > 1 THEN now() - make_interval(mins => g) END,
              CASE WHEN g % 5000 = 1 THEN gen_random_uuid() END,
              CASE WHEN g % 5000 = 1 THEN now() - interval '1 second' END
         FROM generate_series(1, 50000) g`,
      [tenantId],
    );
    for (const table of ['workflows', 'outbox_events', 'notification_settings'])
      await ds.query(`ANALYZE ${table}`);
  });
  afterAll(async () => {
    await truncateAll(ds);
    await ds.destroy();
  });

  async function indexesOf(sql: string, params: unknown[] = []) {
    const [row]: Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }> =
      await ds.query(`EXPLAIN (FORMAT JSON) ${sql}`, params);
    const all = nodes(row['QUERY PLAN'][0].Plan);
    return {
      indexes: all.map((n) => n['Index Name']).filter(Boolean),
      seqScan: all.some((n) => n['Node Type'] === 'Seq Scan'),
    };
  }

  it.each([
    [
      'due schedules of the tick (due_schedule_tenants)',
      `SELECT DISTINCT w."tenantId" FROM workflows w
        WHERE w.enabled AND w.cron IS NOT NULL AND w."nextFireAt" <= now()
        ORDER BY w."tenantId" LIMIT 500`,
      [],
      'IDX_workflows_due',
    ],
    [
      'the next pending event of a tenant (claim_outbox_event)',
      `SELECT id FROM outbox_events o WHERE o."tenantId" = $1 AND o.status = 'pending'
          AND o."nextAttemptAt" <= now() ORDER BY o."nextAttemptAt" LIMIT 1 FOR UPDATE SKIP LOCKED`,
      'tenant',
      'IDX_outbox_events_pending',
    ],
    [
      'an attempt whose lease expired (claim_outbox_event)',
      `SELECT id FROM outbox_events o WHERE o."tenantId" = $1 AND o.status = 'sending'
          AND o."leaseUntil" <= now() ORDER BY o."leaseUntil" LIMIT 1 FOR UPDATE SKIP LOCKED`,
      'tenant',
      'IDX_outbox_events_sending',
    ],
    [
      'delivered events past their retention (purge_delivered_events)',
      `SELECT o.id FROM outbox_events o WHERE o.status = 'delivered'
          AND o."deliveredAt" < now() - make_interval(days => 7)
        ORDER BY o."deliveredAt" LIMIT 1000 FOR UPDATE SKIP LOCKED`,
      [],
      'IDX_outbox_events_delivered',
    ],
    [
      'a page of the event journal of a tenant',
      `SELECT id FROM outbox_events WHERE "tenantId" = $1
        ORDER BY "createdAt" DESC, id DESC LIMIT 51`,
      'tenant',
      'IDX_outbox_events_tenant_created',
    ],
  ])('%s uses its index', async (_case, sql, params, index) => {
    const values = params === 'tenant' ? [tenantId] : (params as unknown[]);
    const { indexes, seqScan } = await indexesOf(sql, values);
    expect(indexes).toContain(index);
    expect(seqScan).toBe(false);
  });
});
