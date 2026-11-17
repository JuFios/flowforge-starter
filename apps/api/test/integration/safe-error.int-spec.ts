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

  it.each([
    ['SELECT $1::uuid', SECRET, '22P02'],
    ['SELECT $1::int', SECRET, '22P02'],
    ['SELECT $1::timestamptz', SECRET, '22007'],
    ['SELECT $1::int', `9999999999999${SECRET.replace(/\D/g, '')}`, '22003'],
    ['SELECT $1::int[]', SECRET, '22P02'],
  ])('%s does not carry the value into the logged error', async (sql, value, code) => {
    const error = await ds.query(sql, [value]).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeDefined();

    const safe = toSafeError(error);
    expect(JSON.stringify(safe)).not.toContain(value);
    expect(safe).toMatchObject({ type: 'QueryFailedError', code });
  });
});
