import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../../src/database/database.options';
import { validateDatabaseEnv } from '../../src/config/env.validation';
import { migrate } from '../../src/database/migrate';
import { provisionLoginRoles } from '../../src/database/provision';
import { API_ROLE, WORKER_ROLE, SYSTEM_ROLE } from '../../src/tenancy/roles';
import { assertSecurityPosture } from '../../src/tenancy/security-posture';
import { testDatabaseUrl } from '../helpers/test-env';
import { waitForBlocked } from '../helpers/transaction-barrier';

it('initializes two databases concurrently on a fresh PostgreSQL cluster', async () => {
  const url = new URL(testDatabaseUrl());
  const admin = await new DataSource({
    type: 'postgres',
    url: url.href,
  }).initialize();
  const suffix = randomBytes(8).toString('hex');
  const roles = [0, 1].map((db) =>
    ([API_ROLE, WORKER_ROLE] as const).map((group, i) => ({
      group,
      user: `ff_cold_${db}_${i}_${suffix}`,
      password: randomBytes(24).toString('hex'),
    })),
  );
  const databases: string[] = [];
  const sources: DataSource[] = [];
  try {
    expect(
      await admin.query('SELECT rolname FROM pg_roles WHERE rolname=ANY($1)', [
        [API_ROLE, WORKER_ROLE, SYSTEM_ROLE],
      ]),
    ).toEqual([]);
    for (const i of [0, 1]) {
      const name = `ff_install_${i}_${suffix}_test`;
      await admin.query(`CREATE DATABASE "${name}"`);
      databases.push(name);
      url.pathname = '/' + name;
      sources.push(
        await new DataSource(
          buildDataSourceOptions(
            validateDatabaseEnv({ DATABASE_URL: url.href }),
          ),
        ).initialize(),
      );
    }
    const barrier = admin.createQueryRunner();
    await barrier.connect();
    await barrier.startTransaction();
    let results: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      await barrier.query('LOCK TABLE pg_catalog.pg_authid IN SHARE MODE');
      results = Promise.allSettled(sources.map((ds) => migrate(ds)));
      await waitForBlocked(admin, barrier, 2);
      await barrier.commitTransaction();
      expect((await results).map((r) => r.status)).toEqual([
        'fulfilled',
        'fulfilled',
      ]);
    } finally {
      if (barrier.isTransactionActive) await barrier.rollbackTransaction();
      await results;
      await barrier.release();
    }
    await Promise.all(
      sources.map((ds, i) =>
        ds.transaction(async (em) => {
          const query = (sql: string, params?: unknown[]) =>
            em.query(sql, params);
          await provisionLoginRoles(query, roles[i]);
          await assertSecurityPosture(query);
        }),
      ),
    );
    for (const ds of sources) expect(await ds.showMigrations()).toBe(false);
  } finally {
    await Promise.all(sources.map((ds) => ds.destroy()));
    for (const name of databases) await admin.query(`DROP DATABASE "${name}"`);
    for (const role of roles.flat())
      await admin.query(`DROP ROLE IF EXISTS "${role.user}"`);
    await admin.destroy();
  }
});
