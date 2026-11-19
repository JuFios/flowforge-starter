import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../../src/database/database.options';
import { TenantDb } from '../../src/tenancy/tenant-db';
import { createTenant, openTestDataSource, truncateAll } from '../helpers/db';
import { testApiDatabaseUrl } from '../helpers/test-env';

/**
 * Контекст тенанта не переживає транзакцію: з'єднання, повернуте в пул, наступному запиту його не
 * передає — ні після COMMIT, ні після ROLLBACK, помилки чи statement_timeout.
 */
describe('tenant context and the connection pool', () => {
  let owner: DataSource;
  /** Пул на одне з'єднання: кожен наступний запит гарантовано отримує те саме з'єднання. */
  let pool: DataSource;
  let db: TenantDb;
  let tenantId: string;

  beforeAll(async () => {
    owner = await openTestDataSource();
    pool = await new DataSource(
      buildDataSourceOptions(
        {
          DATABASE_URL: testApiDatabaseUrl(),
          DB_CONNECT_TIMEOUT_MS: 5_000,
          DB_STATEMENT_TIMEOUT_MS: 300,
        },
        { poolSize: 1 },
      ),
    ).initialize();
    db = new TenantDb(pool);
  });

  beforeEach(async () => {
    await truncateAll(owner);
    tenantId = (await createTenant(owner)).tenant.id;
  });

  afterAll(async () => {
    await pool.destroy();
    await truncateAll(owner);
    await owner.destroy();
  });

  /** Що бачить наступний запит без контексту на тому самому з'єднанні. */
  async function leftover(): Promise<{ setting: string | null; rows: number }> {
    const [row]: Array<{ setting: string | null; rows: number }> =
      await pool.query(
        `SELECT current_setting('app.tenant_id', true) AS setting,
                (SELECT count(*)::int FROM tenants) AS rows`,
      );
    return row;
  }

  /** Без контексту: налаштування не задане (або скинуте в порожнє), рядків не видно. */
  async function expectClean(): Promise<void> {
    const { setting, rows } = await leftover();
    expect([null, '']).toContain(setting);
    expect(rows).toBe(0);
  }

  it('sees the tenant inside the transaction', async () => {
    const rows = await db.run(tenantId, (em): Promise<Array<{ id: string }>> =>
      em.query(`SELECT id FROM tenants`),
    );
    expect(rows).toEqual([{ id: tenantId }]);
  });

  it('leaves nothing behind after COMMIT', async () => {
    await db.run(tenantId, (em) => em.query(`SELECT 1`));
    await expectClean();
  });

  it('leaves nothing behind after an error rolls the transaction back', async () => {
    await expect(
      db.run(tenantId, async (em) => {
        await em.query(`SELECT 1`);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expectClean();
  });

  it('leaves nothing behind after a failed statement', async () => {
    await expect(
      db.run(tenantId, (em) => em.query(`SELECT * FROM no_such_table`)),
    ).rejects.toThrow();
    await expectClean();
  });

  it('leaves nothing behind after statement_timeout cancels a query', async () => {
    await expect(
      db.run(tenantId, (em) => em.query(`SELECT pg_sleep(2)`)),
    ).rejects.toThrow(/statement timeout/);
    await expectClean();
  });

  it('refuses to switch tenants inside one transaction', async () => {
    const other = (await createTenant(owner, 'other')).tenant.id;
    await expect(
      db.transaction(async (tx) => {
        await tx.enter(tenantId);
        await tx.enter(other);
      }),
    ).rejects.toThrow('a transaction cannot switch tenants');
  });

  it('binds the tenant before concurrent enter calls can race', async () => {
    const other = (await createTenant(owner, 'other')).tenant.id;
    await db.transaction(async (tx) => {
      const results = await Promise.allSettled([
        tx.enter(tenantId),
        tx.enter(other),
        tx.enter(tenantId),
      ]);
      expect(results.map((r) => r.status)).toEqual([
        'fulfilled',
        'rejected',
        'fulfilled',
      ]);
      expect(await tx.em.query('SELECT id FROM tenants')).toEqual([
        { id: tenantId },
      ]);
    });
    await expectClean();
  });

  it('refuses a tenant id that is not a UUID before touching the database', async () => {
    await expect(
      db.run("x'); RESET ALL; --", (em) => em.query(`SELECT 1`)),
    ).rejects.toThrow('tenant context requires a tenant UUID');
  });

  it('is the only code that sets the tenant context, and only transaction-locally', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith('.ts')) files.push(path);
      }
    };
    walk(join(__dirname, '../../src'));
    const setters = files.filter((f) =>
      /app\.tenant_id/.test(readFileSync(f, 'utf8')),
    );
    for (const file of setters) {
      const text = readFileSync(file, 'utf8');
      expect(text).not.toMatch(/\bSET\s+(SESSION\s+)?app\.tenant_id/i);
      expect(text).not.toMatch(/set_config\('app\.tenant_id',[^)]*false\)/);
    }
    expect(
      setters
        .filter((f) =>
          /set_config\('app\.tenant_id'/.test(readFileSync(f, 'utf8')),
        )
        .map((f) => f.replace(/^.*\/src\//, 'src/')),
    ).toEqual(['src/tenancy/tenant-db.ts']);
  });
});
