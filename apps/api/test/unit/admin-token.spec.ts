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
  const text = readFileSync(join(__dirname, '../../.env.example'), 'utf8');
  const example = parseEnv(text);

  it('keeps no ADMIN_TOKEN value in apps/api/.env.example (compose gives it only to the API)', () => {
    expect(example).not.toHaveProperty('ADMIN_TOKEN');
  });

  it('refuses the local development value suggested in apps/api/.env.example', () => {
    const suggested = /change-me-admin/.exec(text)?.[0];
    expect(suggested).toBe('change-me-admin');
    expect(() =>
      validateEnv({ ...example, ...production, ADMIN_TOKEN: suggested }),
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
    let error: unknown;
    try {
      validateEnv({ ...production, ADMIN_TOKEN: 'change-me-admin' });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/ADMIN_TOKEN/);
    expect((error as Error).message).not.toContain('change-me-admin');
  });

  it('accepts a random token', () => {
    const token = 'f3a9c27e5b8d41e0a6c3b7d29e8f1a4c5d6e7f80';
    expect(validateEnv({ ...production, ADMIN_TOKEN: token }).ADMIN_TOKEN).toBe(
      token,
    );
  });
});
