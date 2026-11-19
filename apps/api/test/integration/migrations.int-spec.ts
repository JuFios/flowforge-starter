import { DataSource } from 'typeorm';
import { openTestDataSource } from '../helpers/db';
import { provisionTestDatabase } from '../helpers/test-provision';

describe('database migrations', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = await openTestDataSource();
  });

  afterAll(async () => {
    await ds.destroy();
  });

  it('leaves no pending migrations after the schema is built from scratch', async () => {
    expect(await ds.showMigrations()).toBe(false);
  });

  it('produces exactly the schema the entities describe (no drift)', async () => {
    const pending = await ds.driver.createSchemaBuilder().log();
    expect(pending.upQueries.map((q) => q.query)).toEqual([]);
  });

  it('reverts every migration and re-applies them cleanly', async () => {
    const total = ds.migrations.length;
    for (let i = 0; i < total; i++)
      await ds.undoLastMigration({ transaction: 'each' });

    const [{ count }]: Array<{ count: number }> = await ds.query(
      `SELECT count(*)::int AS count FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name <> 'migrations'`,
    );
    expect(count).toBe(0);

    const applied = await ds.runMigrations({ transaction: 'each' });
    await provisionTestDatabase((sql, params) => ds.query(sql, params));
    expect(applied).toHaveLength(total);
    expect((await ds.driver.createSchemaBuilder().log()).upQueries).toEqual([]);
  });

  it('does not rely on synchronize', () => {
    expect(ds.options.synchronize).toBe(false);
  });
});
