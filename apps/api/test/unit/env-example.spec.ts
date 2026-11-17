import { getMetadataStorage } from 'class-validator';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import {
  EnvironmentVariables,
  validateEnv,
} from '../../src/config/env.validation';

/** .env.example використовується docker-compose як є, тож він мусить бути валідним і повним. */
describe('apps/api/.env.example', () => {
  const example = parseEnv(
    readFileSync(join(__dirname, '../../.env.example'), 'utf8'),
  );
  const declared = new Set(
    getMetadataStorage()
      .getTargetValidationMetadatas(EnvironmentVariables, '', true, false)
      .map((m) => m.propertyName),
  );

  it('passes the runtime config validation', () => {
    expect(() => validateEnv(example)).not.toThrow();
  });

  it('lists every variable the config schema knows', () => {
    expect(Object.keys(example).sort()).toEqual([...declared].sort());
  });
});
