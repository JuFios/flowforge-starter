import { getMetadataStorage } from 'class-validator';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import {
  EnvironmentVariables,
  validateEnv,
} from '../../src/config/env.validation';

/** Секрети задаються для кожного процесу окремо, тож у прикладі вони — закоментовані підказки. */
const SECRETS = ['DATABASE_URL', 'ADMIN_TOKEN'];

/**
 * .env.example — несекретна основа конфігурації docker-compose (секрети кожен сервіс отримує
 * окремо), тож він мусить бути валідним і повним.
 */
describe('apps/api/.env.example', () => {
  const text = readFileSync(join(__dirname, '../../.env.example'), 'utf8');
  const example = parseEnv(text);
  const declared = new Set(
    getMetadataStorage()
      .getTargetValidationMetadatas(EnvironmentVariables, '', true, false)
      .map((m) => m.propertyName),
  );

  it('passes the runtime config validation once the process gets its own database URL', () => {
    expect(() =>
      validateEnv({
        ...example,
        DATABASE_URL: 'postgres://flowforge_api:pw@localhost:5432/flowforge',
      }),
    ).not.toThrow();
  });

  it('lists every non-secret variable the config schema knows', () => {
    expect(Object.keys(example).sort()).toEqual(
      [...declared].filter((name) => !SECRETS.includes(name)).sort(),
    );
  });

  it('keeps secrets out of the shared file, as commented hints only', () => {
    for (const name of SECRETS) {
      expect(example).not.toHaveProperty(name);
      expect(text).toMatch(new RegExp(`^# ${name}=$`, 'm'));
    }
  });
});
