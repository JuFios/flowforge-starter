import {
  parseTrustProxy,
  validateApiEnv,
  validateDatabaseEnv,
  validateEnv,
} from '../../src/config/env.validation';

describe('per-process configuration', () => {
  const url = 'postgres://flowforge_worker:pw@localhost:5432/db';

  it('lets the worker start without ADMIN_TOKEN', () => {
    expect(validateEnv({ DATABASE_URL: url }).ADMIN_TOKEN).toBeUndefined();
  });

  it('requires ADMIN_TOKEN for the API', () => {
    expect(() => validateApiEnv({ DATABASE_URL: url })).toThrow(/ADMIN_TOKEN/);
    expect(
      validateApiEnv({ DATABASE_URL: url, ADMIN_TOKEN: 'a-long-admin-token' })
        .ADMIN_TOKEN,
    ).toBe('a-long-admin-token');
  });

  it.each([validateEnv, validateApiEnv])(
    'refuses the schema owner credentials in a runtime process (%p)',
    (validate) => {
      const owner = 'postgres://flowforge:owner-secret@localhost:5432/db';
      let message = '';
      try {
        validate({
          DATABASE_URL: url,
          ADMIN_TOKEN: 'a-long-admin-token',
          MIGRATION_DATABASE_URL: owner,
        });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain('MIGRATION_DATABASE_URL');
      expect(message).not.toContain('owner-secret');
    },
  );
});

describe('validateEnv', () => {
  const base = {
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    ADMIN_TOKEN: 'a-long-admin-token',
  };

  it('applies defaults and converts numeric strings', () => {
    const env = validateEnv({ ...base, PORT: '8080' });
    expect(env).toMatchObject({
      PORT: 8080,
      METRICS_PORT: 3200,
      DB_CONNECT_TIMEOUT_MS: 5_000,
      DB_STATEMENT_TIMEOUT_MS: 30_000,
      WORKER_CONCURRENCY: 4,
      WORKER_HTTP_PORT: 3100,
      SCHEDULER_TICK_MS: 30_000,
      LOG_LEVEL: 'info',
      NODE_ENV: 'development',
    });
  });

  it.each([1, 99, 100, 5000])(
    'accepts a %i ms step timeout with independent outbox settings',
    (timeout) => {
      for (const concurrency of [0, 1]) {
        expect(
          validateEnv({
            ...base,
            HTTP_STEP_TIMEOUT_MS: timeout,
            OUTBOX_CONCURRENCY: concurrency,
          }).HTTP_STEP_TIMEOUT_MS,
        ).toBe(timeout);
      }
    },
  );

  it('rejects a missing DATABASE_URL', () => {
    expect(() => validateEnv({ ADMIN_TOKEN: base.ADMIN_TOKEN })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(() => validateEnv({ ...base, DATABASE_URL: 'mysql://x' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('rejects a short ADMIN_TOKEN', () => {
    expect(() => validateEnv({ ...base, ADMIN_TOKEN: 'short' })).toThrow(
      /ADMIN_TOKEN/,
    );
  });

  it('rejects non-numeric and out-of-range numbers', () => {
    expect(() => validateEnv({ ...base, PORT: 'abc' })).toThrow(/PORT/);
    expect(() => validateEnv({ ...base, WORKER_CONCURRENCY: '0' })).toThrow(
      /WORKER_CONCURRENCY/,
    );
  });

  it('rejects an unknown log level', () => {
    expect(() => validateEnv({ ...base, LOG_LEVEL: 'verbose' })).toThrow(
      /LOG_LEVEL/,
    );
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
    expect(() =>
      validateEnv({ ...base, SCHEDULER_TICK_MS: '2147483648' }),
    ).toThrow(/SCHEDULER_TICK_MS/);
    // Межа пропуску не коротша за тік, тож найбільший тік — разом із найбільшою межею.
    expect(
      validateEnv({
        ...base,
        SCHEDULER_TICK_MS: '2147483647',
        SCHEDULER_MISFIRE_GRACE_MS: '2147483647',
      }).SCHEDULER_TICK_MS,
    ).toBe(2147483647);
    expect(() =>
      validateEnv({ ...base, SCHEDULER_MISFIRE_GRACE_MS: '2147483648' }),
    ).toThrow(/SCHEDULER_MISFIRE_GRACE_MS/);
  });

  it('rejects a missed-run grace shorter than the scheduler tick', () => {
    expect(() =>
      validateEnv({
        ...base,
        SCHEDULER_TICK_MS: '30000',
        SCHEDULER_MISFIRE_GRACE_MS: '29999',
      }),
    ).toThrow(/SCHEDULER_MISFIRE_GRACE_MS/);
    expect(
      validateEnv({
        ...base,
        SCHEDULER_TICK_MS: '30000',
        SCHEDULER_MISFIRE_GRACE_MS: '30000',
      }).SCHEDULER_MISFIRE_GRACE_MS,
    ).toBe(30000);
    expect(validateEnv(base).SCHEDULER_MISFIRE_GRACE_MS).toBe(60000);
  });

  it('accepts METRICS_PORT=0 (random free port) but not out-of-range values', () => {
    expect(validateEnv({ ...base, METRICS_PORT: '0' }).METRICS_PORT).toBe(0);
    expect(() => validateEnv({ ...base, METRICS_PORT: '-1' })).toThrow(
      /METRICS_PORT/,
    );
    expect(() => validateEnv({ ...base, METRICS_PORT: '65536' })).toThrow(
      /METRICS_PORT/,
    );
  });

  it('rejects database timeouts that are missing a bound or out of range', () => {
    expect(() => validateEnv({ ...base, DB_CONNECT_TIMEOUT_MS: '0' })).toThrow(
      /DB_CONNECT_TIMEOUT_MS/,
    );
    expect(() =>
      validateEnv({ ...base, DB_CONNECT_TIMEOUT_MS: '60001' }),
    ).toThrow(/DB_CONNECT_TIMEOUT_MS/);
    expect(() =>
      validateEnv({ ...base, DB_STATEMENT_TIMEOUT_MS: '0' }),
    ).toThrow(/DB_STATEMENT_TIMEOUT_MS/);
    expect(() =>
      validateEnv({ ...base, DB_STATEMENT_TIMEOUT_MS: '600001' }),
    ).toThrow(/DB_STATEMENT_TIMEOUT_MS/);
  });

  it('rejects a retry backoff cap below its base', () => {
    expect(() =>
      validateEnv({
        ...base,
        JOB_BACKOFF_BASE_MS: '5000',
        JOB_BACKOFF_MAX_MS: '1000',
      }),
    ).toThrow(/JOB_BACKOFF_MAX_MS: має бути не менше за JOB_BACKOFF_BASE_MS/);
    expect(
      validateEnv({
        ...base,
        JOB_BACKOFF_BASE_MS: '5000',
        JOB_BACKOFF_MAX_MS: '5000',
      }).JOB_BACKOFF_MAX_MS,
    ).toBe(5000);
  });

  it('bounds the HTTP body limit so the largest valid definition and run input still fit', () => {
    expect(validateEnv(base)).toMatchObject({ HTTP_BODY_LIMIT: 100 * 1024 });
    // 68 КіБ: визначення кроків до 64 КіБ плюс решта полів запиту.
    expect(validateEnv({ ...base, HTTP_BODY_LIMIT: '69632' })).toMatchObject({
      HTTP_BODY_LIMIT: 69_632,
    });
    expect(() => validateEnv({ ...base, HTTP_BODY_LIMIT: '69631' })).toThrow(
      /HTTP_BODY_LIMIT/,
    );
    expect(() =>
      validateEnv({ ...base, HTTP_BODY_LIMIT: String(1024 * 1024 + 1) }),
    ).toThrow(/HTTP_BODY_LIMIT/);
    expect(() => validateEnv({ ...base, HTTP_BODY_LIMIT: '100kb' })).toThrow(
      /HTTP_BODY_LIMIT/,
    );
  });

  it('requires a connection pool large enough for every worker loop', () => {
    expect(validateEnv(base)).toMatchObject({ DB_POOL_SIZE: 10 });
    expect(
      validateEnv({ ...base, WORKER_CONCURRENCY: '64', DB_POOL_SIZE: '68' })
        .DB_POOL_SIZE,
    ).toBe(68);
    expect(() =>
      validateEnv({ ...base, WORKER_CONCURRENCY: '64', DB_POOL_SIZE: '67' }),
    ).toThrow(/DB_POOL_SIZE: має бути не менше за WORKER_CONCURRENCY \+ 4/);
    // Значення за замовчуванням (10) не вміщає 64 цикли — конфігурацію треба задати явно.
    expect(() => validateEnv({ ...base, WORKER_CONCURRENCY: '64' })).toThrow(
      /DB_POOL_SIZE/,
    );
  });
});

describe('validateDatabaseEnv (migration CLI)', () => {
  it('needs only the database variables and applies the same defaults', () => {
    expect(
      validateDatabaseEnv({ DATABASE_URL: 'postgres://u:p@localhost:5432/db' }),
    ).toMatchObject({
      DB_CONNECT_TIMEOUT_MS: 5_000,
      DB_STATEMENT_TIMEOUT_MS: 30_000,
    });
  });

  it('rejects an invalid DATABASE_URL', () => {
    expect(() => validateDatabaseEnv({ DATABASE_URL: 'mysql://x' })).toThrow(
      /DATABASE_URL/,
    );
  });
});

describe('TRUST_PROXY', () => {
  it.each([
    ['false', false],
    ['1', 1],
    ['10', 10],
    ['loopback', ['loopback']],
    ['10.0.0.1, 10.0.0.0/8', ['10.0.0.1', '10.0.0.0/8']],
    ['fd00::/8,uniquelocal', ['fd00::/8', 'uniquelocal']],
  ])('accepts %s', (value, parsed) => {
    expect(parseTrustProxy(value)).toEqual(parsed);
  });

  // `true` дав би клієнту самому задавати свою IP через X-Forwarded-For.
  it.each([
    'true',
    '0',
    '11',
    '0.0.0.0/0',
    '::/0',
    '10.0.0.0/33',
    'fd00::/129',
    'proxy.local',
    '10.0.0.1/8/1',
    '1.2.3',
  ])('rejects %s', (value) => {
    expect(parseTrustProxy(value)).toBeUndefined();
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        TRUST_PROXY: value,
      }),
    ).toThrow(/TRUST_PROXY/);
  });
});
