import { DataSource } from 'typeorm';
import { toSafeError } from '../../src/observability/safe-error';
import { openTestDataSource } from '../helpers/db';

const SECRET = 'ff_live_9f2c1d7e-secret';

/** Справжні помилки Postgres, у тексті яких сервер повторює вхідне значення. */
describe('toSafeError with real Postgres errors', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = await openTestDataSource();
  });

  afterAll(() => ds.destroy());

  // Назва кожного випадку унікальна (SQL + SQLSTATE), щоб його можна було запустити окремо через -t.
  it.each([
    { sql: 'SELECT $1::uuid', value: SECRET, code: '22P02' },
    { sql: 'SELECT $1::int', value: SECRET, code: '22P02' },
    { sql: 'SELECT $1::timestamptz', value: SECRET, code: '22007' },
    {
      sql: 'SELECT $1::int',
      value: `9999999999999${SECRET.replace(/\D/g, '')}`,
      code: '22003',
    },
    { sql: 'SELECT $1::int[]', value: SECRET, code: '22P02' },
  ])(
    '$sql ($code) does not carry the value into the logged error',
    async ({ sql, value, code }) => {
      const error = await ds.query(sql, [value]).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(error).toBeDefined();

      const safe = toSafeError(error);
      expect(JSON.stringify(safe)).not.toContain(value);
      expect(safe).toMatchObject({ type: 'QueryFailedError', code });
    },
  );
});
