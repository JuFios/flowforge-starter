import { limitDefaultsFromEnv } from '../../src/database/provision';
import { BUILT_IN_LIMIT_DEFAULTS } from '../../src/tenancy/limits';

/** Значення лімітів тенантів за замовчуванням, які db:provision бере з env (README, «Контракт лімітів»). */
describe('tenant limit defaults from the environment', () => {
  it('uses the built-in values without variables', () => {
    expect(limitDefaultsFromEnv({})).toEqual(BUILT_IN_LIMIT_DEFAULTS);
    expect(limitDefaultsFromEnv({ TENANT_MAX_RUNNING: '' })).toEqual(
      BUILT_IN_LIMIT_DEFAULTS,
    );
  });

  it('takes every variable within its bounds', () => {
    expect(
      limitDefaultsFromEnv({
        TENANT_MAX_RUNNING: '1000',
        TENANT_MAX_QUEUE_SIZE: '1',
        TENANT_RATE_LIMIT: '1000000',
        TENANT_RATE_WINDOW_MS: '1000',
        TENANT_WEBHOOK_RATE_LIMIT: '5',
        TENANT_WEBHOOK_RATE_WINDOW_MS: '3600000',
      }),
    ).toEqual({
      maxRunning: 1000,
      maxQueueSize: 1,
      rateLimit: 1_000_000,
      rateWindowMs: 1000,
      webhookRateLimit: 5,
      webhookRateWindowMs: 3_600_000,
    });
  });

  it.each([
    ['TENANT_MAX_RUNNING', '0'],
    ['TENANT_MAX_RUNNING', '1001'],
    ['TENANT_MAX_RUNNING', '10.5'],
    ['TENANT_MAX_QUEUE_SIZE', '10000001'],
    ['TENANT_RATE_LIMIT', '-1'],
    ['TENANT_RATE_WINDOW_MS', '999'],
    ['TENANT_WEBHOOK_RATE_WINDOW_MS', '3600001'],
    ['TENANT_WEBHOOK_RATE_LIMIT', 'ten'],
    ['TENANT_MAX_QUEUE_SIZE', '1e3'],
  ])('rejects %s=%s naming the variable and its bounds', (name, value) => {
    expect(() => limitDefaultsFromEnv({ [name]: value })).toThrow(
      new RegExp(`^${name} must be an integer \\d+\\.\\.\\d+$`),
    );
  });
});
