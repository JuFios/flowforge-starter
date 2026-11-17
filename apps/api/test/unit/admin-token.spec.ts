import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { validateEnv } from '../../src/config/env.validation';

/** Публічно відомий токен із прикладу не повинен давати адмін-доступ у production. */
describe('ADMIN_TOKEN in production', () => {
  const production = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  };
  const example = parseEnv(
    readFileSync(join(__dirname, '../../.env.example'), 'utf8'),
  );

  it('refuses the value from apps/api/.env.example', () => {
    expect(() =>
      validateEnv({
        ...example,
        ...production,
        ADMIN_TOKEN: example.ADMIN_TOKEN,
      }),
    ).toThrow(/ADMIN_TOKEN/);
  });

  it.each([
    'change-me-admin',
    'CHANGEME-please-123',
    'change_me_admin_token',
    'example-admin-token',
    'password1234567',
    'aaaaaaaaaaaaaaaa',
    '121212121212121212',
  ])('refuses an obviously insecure value (%s)', (token) => {
    expect(() => validateEnv({ ...production, ADMIN_TOKEN: token })).toThrow(
      /ADMIN_TOKEN/,
    );
  });

  it('does not echo the refused value', () => {
    expect(() =>
      validateEnv({ ...production, ADMIN_TOKEN: 'change-me-admin' }),
    ).toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining('change-me-admin'),
      }),
    );
  });

  it('accepts a random token', () => {
    const token = 'f3a9c27e5b8d41e0a6c3b7d29e8f1a4c5d6e7f80';
    expect(validateEnv({ ...production, ADMIN_TOKEN: token }).ADMIN_TOKEN).toBe(
      token,
    );
  });
});
