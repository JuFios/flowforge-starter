import { DataSource } from 'typeorm';
import { WebhookDeliveries1796000000000 } from '../../src/database/migrations/1796000000000-WebhookDeliveries';
import { createTenant, openTestDataSource } from '../helpers/db';
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

  it('protects an active signing key rotation from a lossy downgrade', async () => {
    const { tenant } = await createTenant(ds);
    const runner = ds.createQueryRunner();
    await runner.connect();
    try {
      const [[{ id }]] = (await runner.query(
        `UPDATE tenants SET "nextWebhookKeyId"=gen_random_uuid(),"nextWebhookSecret"=gen_random_uuid()::text
         WHERE id=$1 RETURNING "nextWebhookKeyId" AS id`,
        [tenant.id],
      )) as [Array<{ id: string }>, number];
      await expect(
        new WebhookDeliveries1796000000000().down(runner),
      ).rejects.toThrow('prevent a lossless downgrade');
      expect(
        await runner.query(
          'SELECT "nextWebhookKeyId" AS id FROM tenants WHERE id=$1',
          [tenant.id],
        ),
      ).toEqual([{ id }]);
    } finally {
      await runner.release();
    }
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
    await provisionTestDatabase(ds);
    expect(applied).toHaveLength(total);
    expect((await ds.driver.createSchemaBuilder().log()).upQueries).toEqual([]);
  });

  it('does not rely on synchronize', () => {
    expect(ds.options.synchronize).toBe(false);
  });
});
