import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { parseEnv } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Команди розділів README працюють у новому терміналі: секрети й ліміти беруться з кореневого
 * `.env` (його створює розділ «Запуск»), а не з оточення поточної оболонки.
 */
const LIMIT_KEYS = [
  'TENANT_MAX_RUNNING',
  'TENANT_MAX_QUEUE_SIZE',
  'TENANT_MAX_WORKFLOWS',
  'TENANT_RATE_LIMIT',
  'TENANT_RATE_WINDOW_MS',
  'TENANT_WEBHOOK_RATE_LIMIT',
  'TENANT_WEBHOOK_RATE_WINDOW_MS',
];
const KEYS = [
  'POSTGRES_PASSWORD',
  'API_DB_PASSWORD',
  'WORKER_DB_PASSWORD',
  ...LIMIT_KEYS,
];

/** Bash-блоки розділу `## <title>` README або документа з `docs/`. */
function blocks(title: string, file = 'README.md'): string[] {
  const docs = readFileSync(join(__dirname, '../../../..', file), 'utf8');
  const section = docs.split(`\n## ${title}\n`)[1]?.split('\n## ')[0] ?? '';
  return [...section.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
}

/**
 * Виконує блок з кореня тимчасового репозиторію в чистому оточенні з фейковим npm, який записує
 * аргументи й ключі з `.env`, що дійшли до нього через оточення.
 */
function runFresh(block: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'ff-readme-'));
  try {
    mkdirSync(join(dir, 'apps/api'), { recursive: true });
    writeFileSync(join(dir, 'apps/api/.env.example'), '');
    writeFileSync(join(dir, 'docker'), '#!/bin/bash\nexit 0\n', {
      mode: 0o700,
    });
    writeFileSync(
      join(dir, '.env'),
      KEYS.map((k) => `${k}=marker${k}`).join('\n') + '\n',
    );
    writeFileSync(
      join(dir, 'npm'),
      '#!/bin/bash\nprintf "%s " "$*" >> "$HOME/seen"\nfor k in ' +
        KEYS.join(' ') +
        '; do if env | grep -q "=.*marker$k"; then printf "%s " "$k" >> "$HOME/seen"; fi; done\necho >> "$HOME/seen"\n',
      { mode: 0o700 },
    );
    execFileSync('bash', ['-eu', '-c', block], {
      cwd: dir,
      env: { PATH: dir + ':' + process.env.PATH, HOME: dir },
      stdio: 'pipe',
    });
    return readFileSync(join(dir, 'seen'), 'utf8')
      .trim()
      .split('\n')
      .map((s) => s.trim());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('README commands in a new terminal', () => {
  it('passes the owner password and the role secrets to the migration commands', () => {
    const [block] = blocks('Міграції БД', 'docs/operations.md').filter((b) =>
      b.includes('MIGRATION_DATABASE_URL'),
    );
    expect(block).toBeDefined();
    // Шаблон імені нової міграції (`<Name>`) — не команда для виконання.
    const seen = runFresh(
      block
        .split('\n')
        .filter((line) => !/<\w+>/.test(line))
        .join('\n'),
    );
    expect(seen).toContain('run db:migrate POSTGRES_PASSWORD');
    expect(seen).toContain(
      'run db:provision POSTGRES_PASSWORD API_DB_PASSWORD WORKER_DB_PASSWORD ' +
        LIMIT_KEYS.join(' '),
    );
  });

  it('passes every default tenant limit during local startup outside Compose', () => {
    const [block] = blocks('Запуск', 'docs/operations.md').filter((source) =>
      source.includes('LOCAL_API'),
    );
    expect(block).toBeDefined();
    expect(runFresh(block)).toContain(
      'run db:provision POSTGRES_PASSWORD API_DB_PASSWORD WORKER_DB_PASSWORD ' +
        LIMIT_KEYS.join(' '),
    );
  });

  it('builds the test database URL with the owner password from the root .env', () => {
    const [block] = blocks('Тести').filter((b) =>
      b.includes('TEST_DATABASE_URL'),
    );
    expect(block).toBeDefined();
    expect(runFresh(block)).toContain('run test:integration POSTGRES_PASSWORD');
  });

  /**
   * Локальний запуск (README «Запуск»): `cp .env.example .env` дає робочий `.env` для compose —
   * усі чотири секрети задано заглушками, а режим — development.
   */
  it('prepares a working local .env from the example', () => {
    const command = blocks('Запуск')[0]
      .split('\n')
      .filter((line) => !/docker compose|docker-compose/.test(line))
      .join('\n');
    expect(command).toContain('cp .env.example .env');
    const dir = mkdtempSync(join(tmpdir(), 'ff-env-'));
    try {
      writeFileSync(
        join(dir, '.env.example'),
        readFileSync(join(__dirname, '../../../../.env.example')),
      );
      execFileSync('bash', ['-eu', '-c', command], {
        cwd: dir,
        env: { PATH: process.env.PATH, HOME: dir },
        stdio: 'pipe',
      });
      const env = parseEnv(readFileSync(join(dir, '.env'), 'utf8'));
      expect(env.NODE_ENV).toBe('development');
      expect(env.PUBLISH_ADDRESS).toBe('127.0.0.1');
      for (const name of [
        'ADMIN_TOKEN',
        'POSTGRES_PASSWORD',
        'API_DB_PASSWORD',
        'WORKER_DB_PASSWORD',
      ])
        expect(env[name]).toEqual(expect.any(String));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // util.parseEnv, яким команди README читають .env, з'явився в Node 21.7.0 і перенесений у 20.12.0:
  // 21.0–21.6 його не мають, тож одного «>=20.12.0» замало.
  it('admits only Node.js versions with util.parseEnv and states the same range in the operations guide', () => {
    const { engines } = JSON.parse(
      readFileSync(join(__dirname, '../../package.json'), 'utf8'),
    ) as { engines: { node: string } };
    expect(engines.node).toBe('^20.12.0 || >=21.7.0');
    const docs = readFileSync(
      join(__dirname, '../../../../docs/operations.md'),
      'utf8',
    );
    expect(docs).toContain(
      'Потрібні Node.js 20.12+ (гілка 20) або 21.7+ (21 і новіші)',
    );
  });
});
