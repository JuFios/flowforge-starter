import { DataSource } from 'typeorm';
import { validateDatabaseEnv } from '../../src/config/env.validation';
import { buildDataSourceOptions } from '../../src/database/database.options';
import { SystemDb } from '../../src/tenancy/system-db';
import { openTestDataSource } from '../helpers/db';
import { testDatabaseUrl } from '../helpers/test-env';

/**
 * Читання глибини черги для метрик обмежене найменшим із двох: власною короткою межею (2 с) і
 * `statement_timeout` сесії. Інакше коротший `DB_STATEMENT_TIMEOUT_MS` переставав би діяти, а
 * клієнтський `query_timeout` (statement_timeout + запас) спрацьовував би раніше за сервер.
 */
describe('queue depth read timeout', () => {
  let owner: DataSource;

  beforeAll(async () => {
    owner = await openTestDataSource();
  });

  afterAll(async () => {
    await owner.destroy();
  });

  /** Підміняє `queue_depth_by_tenant()` функцією, що спить `seconds`, на час `run`. */
  async function withSlowDepth(
    seconds: number,
    run: () => Promise<void>,
  ): Promise<void> {
    await owner.query(
      'ALTER FUNCTION queue_depth_by_tenant() RENAME TO queue_depth_by_tenant_real',
    );
    try {
      await owner.query(
        `CREATE FUNCTION queue_depth_by_tenant()
           RETURNS TABLE("tenantId" uuid, queued integer, running integer)
           LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(${seconds}); END $$`,
      );
      await run();
    } finally {
      await owner.query('DROP FUNCTION IF EXISTS queue_depth_by_tenant()');
      await owner.query(
        'ALTER FUNCTION queue_depth_by_tenant_real() RENAME TO queue_depth_by_tenant',
      );
    }
  }

  async function timed(
    ds: DataSource,
  ): Promise<{ error?: unknown; ms: number }> {
    const started = performance.now();
    try {
      await new SystemDb(ds).queueDepthByTenant();
      return { ms: performance.now() - started };
    } catch (error) {
      return { error, ms: performance.now() - started };
    }
  }

  // Сон обрано так, щоб скасувати читання могла лише межа, яку перевіряє випадок: 1,5 с менше
  // за власну межу 2 с, а 4 с більше за неї. Якщо межа не діє, сон завершується без помилки.
  // Тому доказ — код 57014 і завершення раніше за сон, а не час, що включає планування клієнта.
  it.each<[string, () => DataSource, number]>([
    [
      'a shorter DB_STATEMENT_TIMEOUT_MS',
      () =>
        new DataSource(
          buildDataSourceOptions(
            validateDatabaseEnv({
              DATABASE_URL: testDatabaseUrl(),
              DB_STATEMENT_TIMEOUT_MS: '100',
            }),
          ),
        ),
      1.5,
    ],
    [
      'the default DB_STATEMENT_TIMEOUT_MS',
      () =>
        new DataSource(
          buildDataSourceOptions(
            validateDatabaseEnv({ DATABASE_URL: testDatabaseUrl() }),
          ),
        ),
      4,
    ],
    [
      'a session without a statement timeout',
      () => new DataSource({ type: 'postgres', url: testDatabaseUrl() }),
      4,
    ],
  ])(
    'cancels the read on the server within %s',
    async (_case, source, sleepSeconds) => {
      const ds = await source().initialize();
      try {
        await withSlowDepth(sleepSeconds, async () => {
          const { error, ms } = await timed(ds);
          // 57014 query_canceled: «canceling statement due to statement timeout».
          expect(error).toMatchObject({ driverError: { code: '57014' } });
          expect(ms).toBeLessThan(sleepSeconds * 1000);
        });
      } finally {
        await ds.destroy();
      }
    },
  );

  // Сервер скасовує читання через 100 мс незалежно від того, коли клієнт обробить відповідь.
  // Затримка циклу подій клієнта (повільний раннер CI, GC) не змінює властивості, тож перевірка
  // не повинна від неї залежати.
  it('keeps the verdict when the client event loop is stalled after the query is sent', async () => {
    const ds = await new DataSource(
      buildDataSourceOptions(
        validateDatabaseEnv({
          DATABASE_URL: testDatabaseUrl(),
          DB_STATEMENT_TIMEOUT_MS: '100',
        }),
      ),
    ).initialize();
    try {
      await withSlowDepth(1.5, async () => {
        const pending = timed(ds);
        const stalledUntil = performance.now() + 350;
        while (performance.now() < stalledUntil) {
          // Синхронна робота клієнта: відповідь сервера чекає в сокеті.
        }
        const { error, ms } = await pending;
        expect(error).toMatchObject({ driverError: { code: '57014' } });
        expect(ms).toBeLessThan(1_500);
      });
    } finally {
      await ds.destroy();
    }
  });
});
