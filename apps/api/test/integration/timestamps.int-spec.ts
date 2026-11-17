import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../../src/database/database.options';
import { Execution, Job, StepRun, Tenant, Workflow } from '../../src/entities';
import { openTestDataSource, truncateAll } from '../helpers/db';
import { testDatabaseEnv, testDatabaseUrl } from '../helpers/test-env';

/** Підключення, сесія якого працює в заданому часовому поясі (як процес/сервер з іншим TimeZone). */
async function openSessionIn(timeZone: string): Promise<DataSource> {
  const options = buildDataSourceOptions(testDatabaseEnv());
  return new DataSource({
    ...options,
    extra: { ...(options.extra ?? {}), options: `-c TimeZone=${timeZone}` },
  }).initialize();
}

/** Кожна колонка «момент створення/старту», яку заповнює DEFAULT now(). */
const COLUMNS: Array<{
  name: string;
  insert: (ds: DataSource) => Promise<Date>;
}> = [
  {
    name: 'tenants.createdAt',
    insert: async (ds) =>
      (
        await ds
          .getRepository(Tenant)
          .save({ name: 't', apiKeyHash: randomUUID(), webhookSecret: 's' })
      ).createdAt,
  },
  {
    name: 'workflows.createdAt',
    insert: async (ds) =>
      (
        await ds
          .getRepository(Workflow)
          .save({ tenantId: randomUUID(), name: 'w', steps: [] })
      ).createdAt,
  },
  {
    name: 'executions.createdAt',
    insert: async (ds) =>
      (
        await ds
          .getRepository(Execution)
          .save({ tenantId: randomUUID(), workflowId: randomUUID() })
      ).createdAt,
  },
  {
    name: 'jobs.createdAt',
    insert: async (ds) =>
      (
        await ds
          .getRepository(Job)
          .save({ tenantId: randomUUID(), executionId: randomUUID() })
      ).createdAt,
  },
  {
    name: 'step_runs.startedAt',
    insert: async (ds) =>
      (
        await ds
          .getRepository(StepRun)
          .save({ executionId: randomUUID(), stepIndex: 0, stepId: 's' })
      ).startedAt,
  },
];

const HOUR_MS = 3_600_000;

describe('timestamps are absolute moments, independent of the session time zone', () => {
  let reader: DataSource;
  let east: DataSource;
  let west: DataSource;

  beforeAll(async () => {
    reader = await openTestDataSource();
    // UTC+14 і UTC-11: різниця 25 годин, тож зсув неможливо сплутати з розбіжністю годинників.
    east = await openSessionIn('Pacific/Kiritimati');
    west = await openSessionIn('Pacific/Pago_Pago');
  });

  beforeEach(() => truncateAll(reader));

  afterAll(async () => {
    await Promise.all([reader.destroy(), east.destroy(), west.destroy()]);
  });

  it.each(COLUMNS)(
    '$name written at the same moment from different time zones reads as the same moment',
    async ({ insert }) => {
      const before = Date.now();
      const fromEast = await insert(east);
      const fromWest = await insert(west);
      const after = Date.now();

      const drift = Math.abs(fromEast.getTime() - fromWest.getTime());
      expect(drift / HOUR_MS).toBeLessThan(1 / 60);
      // І це справжній момент запису (допуск — на розбіжність годинника контейнера БД і хоста).
      for (const value of [fromEast, fromWest]) {
        expect(value.getTime()).toBeGreaterThan(before - 60_000);
        expect(value.getTime()).toBeLessThan(after + 60_000);
      }
    },
  );
});

describe('TimestampsWithTimeZone migration', () => {
  it('keeps the moment of rows written before it, also when the server time zone is not UTC', async () => {
    const admin = await openTestDataSource();
    const dbName = new URL(testDatabaseUrl()).pathname.slice(1);
    // Новий сеанс успадковує пояс бази — як сервер, налаштований не в UTC.
    await admin.query(
      `ALTER DATABASE "${dbName}" SET timezone TO 'Pacific/Kiritimati'`,
    );
    const session = await openTestDataSource();
    try {
      const ours = session.migrations.findIndex(
        (m) => m.name === 'TimestampsWithTimeZone1794920300000',
      );
      expect(ours).toBeGreaterThanOrEqual(0);
      const newer = session.migrations.length - ours;
      for (let i = 0; i < newer; i++)
        await session.undoLastMigration({ transaction: 'each' });
      await truncateAll(session);

      // Рядок у старій схемі (timestamp without time zone), записаний як у стартовому коді.
      const [{ id, moment }] = await session.query(
        `INSERT INTO "tenants" ("name", "apiKeyHash", "webhookSecret") VALUES ('old', 'h', 's') RETURNING "id", now() AS "moment"`,
      );

      await session.runMigrations({ transaction: 'each' });

      const [{ createdAt }] = await session.query(
        `SELECT "createdAt" FROM "tenants" WHERE "id" = $1`,
        [id],
      );
      expect((createdAt as Date).toISOString()).toBe(
        (moment as Date).toISOString(),
      );
    } finally {
      await admin.query(`ALTER DATABASE "${dbName}" RESET timezone`);
      await truncateAll(admin);
      await Promise.all([session.destroy(), admin.destroy()]);
    }
  });
});
