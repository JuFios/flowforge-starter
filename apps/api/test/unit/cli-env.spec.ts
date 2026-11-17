import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDotEnvIfPresent } from '../../src/database/cli-env';

describe('loadDotEnvIfPresent (migration CLI)', () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  it('loads variables from .env in the given directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-env-'));
    writeFileSync(
      join(dir, '.env'),
      'FF_CLI_TEST_URL=postgres://u:p@localhost:5432/db\n',
    );
    delete process.env.FF_CLI_TEST_URL;

    expect(loadDotEnvIfPresent(dir)).toBe(true);
    expect(process.env.FF_CLI_TEST_URL).toBe(
      'postgres://u:p@localhost:5432/db',
    );
  });

  it('does not override variables already set in the environment (docker-compose)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-env-'));
    writeFileSync(join(dir, '.env'), 'FF_CLI_TEST_URL=from-file\n');
    process.env.FF_CLI_TEST_URL = 'from-env';

    loadDotEnvIfPresent(dir);
    expect(process.env.FF_CLI_TEST_URL).toBe('from-env');
  });

  it('is a no-op when there is no .env file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-env-'));
    expect(loadDotEnvIfPresent(dir)).toBe(false);
  });
});
