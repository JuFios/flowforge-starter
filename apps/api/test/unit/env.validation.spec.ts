import { validateEnv } from '../../src/config/env.validation';

describe('validateEnv', () => {
  const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/db', ADMIN_TOKEN: 'a-long-admin-token' };

  it('applies defaults and converts numeric strings', () => {
    const env = validateEnv({ ...base, PORT: '8080' });
    expect(env).toMatchObject({
      PORT: 8080,
      WORKER_CONCURRENCY: 4,
      WORKER_HTTP_PORT: 3100,
      SCHEDULER_TICK_MS: 30_000,
      LOG_LEVEL: 'info',
      NODE_ENV: 'development',
    });
  });

  it('rejects a missing DATABASE_URL', () => {
    expect(() => validateEnv({ ADMIN_TOKEN: base.ADMIN_TOKEN })).toThrow(/DATABASE_URL/);
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(() => validateEnv({ ...base, DATABASE_URL: 'mysql://x' })).toThrow(/DATABASE_URL/);
  });

  it('rejects a short ADMIN_TOKEN', () => {
    expect(() => validateEnv({ ...base, ADMIN_TOKEN: 'short' })).toThrow(/ADMIN_TOKEN/);
  });

  it('rejects non-numeric and out-of-range numbers', () => {
    expect(() => validateEnv({ ...base, PORT: 'abc' })).toThrow(/PORT/);
    expect(() => validateEnv({ ...base, WORKER_CONCURRENCY: '0' })).toThrow(/WORKER_CONCURRENCY/);
  });

  it('rejects an unknown log level', () => {
    expect(() => validateEnv({ ...base, LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
  });

  it('never echoes secret values in the error message', () => {
    const secret = 'postgres-password-should-not-leak';
    try {
      validateEnv({ DATABASE_URL: `not-a-url-${secret}`, ADMIN_TOKEN: 'x' });
      throw new Error('expected validation to fail');
    } catch (err) {
      expect((err as Error).message).toMatch(/DATABASE_URL/);
      expect((err as Error).message).not.toContain(secret);
    }
  });

  it('rejects timer values Node would silently clamp to 1 ms', () => {
    // setInterval/setTimeout приймають щонайбільше 2^31-1 мс; більше значення стає 1 мс.
    expect(() => validateEnv({ ...base, SCHEDULER_TICK_MS: '2147483648' })).toThrow(/SCHEDULER_TICK_MS/);
    expect(validateEnv({ ...base, SCHEDULER_TICK_MS: '2147483647' }).SCHEDULER_TICK_MS).toBe(2147483647);
  });
});
