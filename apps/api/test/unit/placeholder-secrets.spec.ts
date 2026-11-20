import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import {
  checkPlaceholderSecrets,
  validateDatabaseEnv,
  validateEnv,
} from '../../src/config/env.validation';

/**
 * Заглушки секретів із кореневого `.env.example` (README «Запуск»): робочі для локального
 * compose, але кожна з них зупиняє процес у NODE_ENV=production — API й воркер (`ADMIN_TOKEN`,
 * пароль у `DATABASE_URL`), `db:migrate` (пароль власника) і `db:provision` (паролі ролей).
 */
describe('placeholder secrets from .env.example', () => {
  const example = parseEnv(
    readFileSync(join(__dirname, '../../../../.env.example'), 'utf8'),
  );
  const url = (user: string, password: string | undefined) =>
    `postgres://${user}:${password}@localhost:5432/flowforge`;
  const base = { ADMIN_TOKEN: example.ADMIN_TOKEN };

  it('starts in development with every placeholder, warning without printing values', () => {
    const write = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      expect(() =>
        validateEnv({
          ...base,
          NODE_ENV: 'development',
          DATABASE_URL: url('flowforge_api', example.API_DB_PASSWORD),
        }),
      ).not.toThrow();
      const output = write.mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(output).toContain('placeholder secrets in use');
      for (const value of [example.ADMIN_TOKEN, example.API_DB_PASSWORD])
        expect(output).not.toContain(value);
    } finally {
      write.mockRestore();
    }
  });

  it.each([
    [
      'the admin token',
      {
        ...base,
        DATABASE_URL: url('flowforge_api', 'Z9'.repeat(16) + 'qwKx81mN'),
      },
    ],
    [
      'the API role password',
      {
        ADMIN_TOKEN: 'Zq7Rk2Lm9Tx4Vb8Nc3Wd6Yf1',
        DATABASE_URL: url('flowforge_api', example.API_DB_PASSWORD),
      },
    ],
    [
      'the worker role password',
      {
        ADMIN_TOKEN: 'Zq7Rk2Lm9Tx4Vb8Nc3Wd6Yf1',
        DATABASE_URL: url('flowforge_worker', example.WORKER_DB_PASSWORD),
      },
    ],
  ])('rejects %s in production', (_case, env) => {
    expect(() => validateEnv({ ...env, NODE_ENV: 'production' })).toThrow(
      /заглушка заборонені/,
    );
  });

  it('rejects the owner password for migrations in production', () => {
    expect(() =>
      validateDatabaseEnv({
        NODE_ENV: 'production',
        DATABASE_URL: url('flowforge', example.POSTGRES_PASSWORD),
      }),
    ).toThrow(/DATABASE_URL: у NODE_ENV=production/);
  });

  it('rejects role passwords in db:provision in production', () => {
    for (const name of ['API_DB_PASSWORD', 'WORKER_DB_PASSWORD'])
      expect(() =>
        checkPlaceholderSecrets(
          { NODE_ENV: 'production' },
          { [name]: example[name] },
        ),
      ).toThrow(new RegExp(name));
  });
});
