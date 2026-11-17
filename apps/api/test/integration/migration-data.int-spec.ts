import { DataSource } from 'typeorm';
import { openTestDataSource, truncateAll } from '../helpers/db';

/**
 * Міграції, що перетворюють наявні дані (а не лише схему): БД відкочується до стану перед
 * міграцією, заповнюється даними в старому форматі, і міграція застосовується знову.
 */
describe('data migrations', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = await openTestDataSource();
  });

  afterAll(async () => {
    // Схема мусить лишитися повною для наступних тестів, навіть якщо тест упав посередині.
    await ds.runMigrations({ transaction: 'each' });
    await truncateAll(ds);
    await ds.destroy();
  });

  /** Відкочує міграції, доки не буде скасовано міграцію з назвою, що починається з `name`. */
  async function revertThrough(name: string): Promise<void> {
    for (;;) {
      const [last]: Array<{ name: string }> = await ds.query(
        `SELECT name FROM migrations ORDER BY id DESC LIMIT 1`,
      );
      await ds.undoLastMigration({ transaction: 'each' });
      if (last.name.startsWith(name)) return;
    }
  }

  it('StepCheckpoints keeps one step run per step: the successful one, counting the attempts', async () => {
    await truncateAll(ds);
    await revertThrough('StepCheckpoints');
    const executionId = '00000000-0000-4000-8000-000000000001';
    const rows: Array<[number, string, string, string]> = [
      [0, 'fetch', 'failed', '2026-01-01T00:00:01Z'],
      [0, 'fetch', 'succeeded', '2026-01-01T00:00:02Z'],
      [0, 'fetch', 'succeeded', '2026-01-01T00:00:05Z'],
      [1, 'send', 'failed', '2026-01-01T00:00:03Z'],
      [1, 'send', 'failed', '2026-01-01T00:00:04Z'],
    ];
    for (const [stepIndex, stepId, status, startedAt] of rows) {
      await ds.query(
        `INSERT INTO step_runs ("executionId", "stepIndex", "stepId", status, "startedAt")
         VALUES ($1, $2, $3, $4, $5)`,
        [executionId, stepIndex, stepId, status, startedAt],
      );
    }

    await ds.runMigrations({ transaction: 'each' });

    const after: Array<{
      stepIndex: number;
      status: string;
      attempts: number;
      startedAt: Date;
    }> = await ds.query(
      `SELECT "stepIndex", status, attempts, "startedAt" FROM step_runs ORDER BY "stepIndex"`,
    );
    expect(
      after.map((r) => [
        r.stepIndex,
        r.status,
        r.attempts,
        r.startedAt.toISOString(),
      ]),
    ).toEqual([
      [0, 'succeeded', 3, '2026-01-01T00:00:05.000Z'],
      [1, 'failed', 2, '2026-01-01T00:00:04.000Z'],
    ]);
  });
});
