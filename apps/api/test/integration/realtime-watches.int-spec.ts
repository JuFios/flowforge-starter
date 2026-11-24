import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { MAX_WATCHES_PER_RENEWAL } from '../../src/database/migrations/1797600000000-RealtimeWatches';
import { ExecutionWatches } from '../../src/realtime/execution-watches.service';
import { SystemDb } from '../../src/tenancy/system-db';
import { TenantDb } from '../../src/tenancy/tenant-db';
import {
  createExecution,
  createTenant,
  createWorkflow,
  openTestDataSource,
  truncateAll,
} from '../helpers/db';
import {
  testApiDatabaseUrl,
  testDatabaseUrl,
  testWorkerDatabaseUrl,
} from '../helpers/test-env';
import { sleep, waitFor } from '../helpers/wait-for';

/**
 * Сповіщення `ff_execution` лише для переглянутих виконань (docs/architecture.md, «Сповіщення лише
 * для переглянутих виконань»): підписки інстансів API в `realtime_watches`, тригер під будь-якою
 * роллю, гонка підписки з транзакцією, що вже змінює виконання, і продовження підписок.
 */
describe('realtime watches', () => {
  let owner: DataSource;
  let api: DataSource;
  let worker: DataSource;
  let listener: Client;
  const received: string[] = [];
  let tenantId: string;
  let executionId: string;
  let watches: ExecutionWatches;

  /** Змінює виконання під роллю воркера в контексті тенанта (як крок у воркері). */
  async function touchAsWorker(id = executionId) {
    await worker.transaction(async (em) => {
      await em.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        tenantId,
      ]);
      await em.query(`UPDATE executions SET error = 'touched' WHERE id = $1`, [
        id,
      ]);
    });
  }

  /** Чи надійшло сповіщення про виконання протягом короткого вікна. */
  async function notified(id = executionId): Promise<boolean> {
    const key = `${tenantId}:${id}`;
    const deadline = Date.now() + 500;
    while (Date.now() < deadline) {
      if (received.includes(key)) return true;
      await sleep(20);
    }
    return false;
  }

  async function watchRows(): Promise<
    Array<{ executionId: string; instanceId: string }>
  > {
    return owner.query(
      `SELECT "executionId", "instanceId" FROM realtime_watches ORDER BY "executionId"`,
    );
  }

  beforeAll(async () => {
    owner = await openTestDataSource();
    api = await new DataSource({
      type: 'postgres',
      url: testApiDatabaseUrl(),
    }).initialize();
    worker = await new DataSource({
      type: 'postgres',
      url: testWorkerDatabaseUrl(),
    }).initialize();
    listener = new Client({ connectionString: testDatabaseUrl() });
    await listener.connect();
    listener.on('notification', (msg) => {
      if (msg.payload) received.push(msg.payload);
    });
    await listener.query('LISTEN ff_execution');
  });

  beforeEach(async () => {
    await truncateAll(owner);
    received.length = 0;
    tenantId = (await createTenant(owner)).tenant.id;
    executionId = (
      await createExecution(owner, await createWorkflow(owner, tenantId))
    ).id;
    watches = new ExecutionWatches(new TenantDb(api), new SystemDb(api));
  });

  afterAll(async () => {
    await listener.end();
    await truncateAll(owner);
    await worker.destroy();
    await api.destroy();
    await owner.destroy();
  });

  it('notifies only while an execution is watched, whatever role changes it', async () => {
    await touchAsWorker();
    expect(await notified()).toBe(false);

    await watches.watch(tenantId, executionId);
    expect(await watchRows()).toEqual([
      { executionId, instanceId: watches.instanceId },
    ]);
    await touchAsWorker();
    expect(await notified()).toBe(true);

    received.length = 0;
    await owner.query(`UPDATE executions SET error = 'owner' WHERE id = $1`, [
      executionId,
    ]);
    expect(await notified()).toBe(true);

    watches.unwatch(tenantId, executionId);
    await waitFor('watch row removed', async () => {
      return (await watchRows()).length === 0;
    });
    received.length = 0;
    await touchAsWorker();
    expect(await notified()).toBe(false);
  });

  it('keeps one row per execution and instance until the last socket leaves', async () => {
    await Promise.all([
      watches.watch(tenantId, executionId),
      watches.watch(tenantId, executionId),
    ]);
    const other = new ExecutionWatches(new TenantDb(api), new SystemDb(api));
    await other.watch(tenantId, executionId);
    expect(await watchRows()).toHaveLength(2);
    watches.unwatch(tenantId, executionId);
    await sleep(200);
    expect(await watchRows()).toHaveLength(2);
    watches.unwatch(tenantId, executionId);
    await waitFor('own row removed', async () => {
      const rows = await watchRows();
      return rows.length === 1 && rows[0].instanceId === other.instanceId;
    });
  });

  it('a page reopened right after the last one closed keeps its watch row', async () => {
    for (let i = 0; i < 20; i++) {
      await watches.watch(tenantId, executionId);
      watches.unwatch(tenantId, executionId);
      // Нова підписка одразу після закриття: її вставка стає в чергу після видалення.
      await watches.watch(tenantId, executionId);
      await sleep(30);
      expect(await watchRows()).toEqual([
        { executionId, instanceId: watches.instanceId },
      ]);
      watches.unwatch(tenantId, executionId);
      await waitFor(
        'row removed',
        async () => (await watchRows()).length === 0,
      );
    }
  });

  it('release waits for a watch still being inserted, so no row outlives the instance', async () => {
    const inserting = watches.watch(tenantId, executionId);
    await watches.release();
    await inserting;
    expect(await watchRows()).toEqual([]);
  });

  it('commits the watch only after a transaction already changing the execution: its change is read, later ones notify', async () => {
    const runner = owner.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    let registered = false;
    try {
      await runner.query(
        `UPDATE executions SET status = 'running' WHERE id = $1`,
        [executionId],
      );
      const pending = watches.watch(tenantId, executionId).then(() => {
        registered = true;
      });
      await sleep(300);
      // Підписка чекає на транзакцію, чий тригер ще не бачив підписки.
      expect(registered).toBe(false);
      await runner.commitTransaction();
      await pending;
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
    }
    // Після підписки знімок бачить зміну транзакції, що завершилась раніше...
    const [row]: Array<{ status: string }> = await api.transaction(
      async (em) => {
        await em.query(`SELECT set_config('app.tenant_id', $1, true)`, [
          tenantId,
        ]);
        return em.query(`SELECT status FROM executions WHERE id = $1`, [
          executionId,
        ]);
      },
    );
    expect(row.status).toBe('running');
    // ...а наступна зміна дає сповіщення.
    received.length = 0;
    await touchAsWorker();
    expect(await notified()).toBe(true);
  });

  it('renewal restores lost rows, drops rows no longer watched and purges expired ones of vanished instances', async () => {
    const second = (
      await createExecution(
        owner,
        await createWorkflow(owner, tenantId, 'second'),
      )
    ).id;
    await watches.watch(tenantId, executionId);
    await watches.watch(tenantId, second);
    // Рядок сплив і зник (БД була недоступна довше за строк дії).
    await owner.query(`DELETE FROM realtime_watches WHERE "executionId" = $1`, [
      executionId,
    ]);
    // Рядок зниклого інстансу, чий строк минув.
    await owner.query(
      `INSERT INTO realtime_watches ("executionId", "tenantId", "instanceId", "expiresAt")
       VALUES ($1, $2, gen_random_uuid(), now() - interval '1 second')`,
      [executionId, tenantId],
    );
    expect(await watches.renew()).toBe(1);
    expect(await watchRows()).toEqual(
      [executionId, second]
        .sort()
        .map((id) => ({ executionId: id, instanceId: watches.instanceId })),
    );

    watches.unwatch(tenantId, second);
    // Продовження з переліком без `second` прибирає й рядок, видалення якого не вдалося.
    await owner.query(
      `INSERT INTO realtime_watches ("executionId", "tenantId", "instanceId", "expiresAt")
       VALUES ($1, $2, $3, now() + interval '1 minute') ON CONFLICT DO NOTHING`,
      [second, tenantId, watches.instanceId],
    );
    await watches.renew();
    expect(await watchRows()).toEqual([
      { executionId, instanceId: watches.instanceId },
    ]);

    await watches.release();
    expect(await watchRows()).toEqual([]);
  });

  it('renewal accepts only existing executions of the named tenant and bounded arguments', async () => {
    const other = (await createTenant(owner, 'other')).tenant.id;
    const system = new SystemDb(api);
    const instance = '00000000-0000-4000-8000-0000000000cc';
    // Чуже виконання під іншим тенантом не підписується.
    expect(
      await system.renewRealtimeWatches(
        instance,
        [executionId],
        [other],
        45_000,
      ),
    ).toBe(0);
    expect(await watchRows()).toEqual([]);
    for (const [executions, tenants, ttl] of [
      [[executionId], [], 45_000],
      [[], [], 999],
      [[], [], 600_001],
      [
        Array.from({ length: MAX_WATCHES_PER_RENEWAL + 1 }, () => executionId),
        Array.from({ length: MAX_WATCHES_PER_RENEWAL + 1 }, () => tenantId),
        45_000,
      ],
    ] as const)
      await expect(
        system.renewRealtimeWatches(
          instance,
          [...executions],
          [...tenants],
          ttl,
        ),
      ).rejects.toThrow(/invalid watch renewal arguments/);
    // Межа включна: стільки підписок, скільки сокетів допускає найбільше REALTIME_MAX_CONNECTIONS.
    expect(
      await system.renewRealtimeWatches(
        instance,
        Array.from({ length: MAX_WATCHES_PER_RENEWAL }, () => executionId),
        Array.from({ length: MAX_WATCHES_PER_RENEWAL }, () => tenantId),
        45_000,
      ),
    ).toBe(1);
  });

  it('a watch row of tenant A is invisible to tenant B and the worker role cannot read it', async () => {
    await watches.watch(tenantId, executionId);
    const other = (await createTenant(owner, 'other')).tenant.id;
    const seenByOther = await api.transaction(async (em) => {
      await em.query(`SELECT set_config('app.tenant_id', $1, true)`, [other]);
      return em.query<unknown[]>('SELECT * FROM realtime_watches');
    });
    expect(seenByOther).toEqual([]);
    await expect(
      worker.query('SELECT * FROM realtime_watches'),
    ).rejects.toThrow(/permission denied/);
    expect(await api.query('SELECT * FROM realtime_watches')).toEqual([]);
  });
});
