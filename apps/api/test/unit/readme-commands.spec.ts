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
  'TENANT_MAX_OUTBOX_EVENTS',
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

const ROOT = join(__dirname, '../../../..');
/** Документи з командами для оператора й розробника. */
const DOC_FILES = ['README.md', 'docs/operations.md', 'docs/architecture.md'];
const DB_URL_SCRIPT = 'apps/api/scripts/test-database-url.cjs';

function bashBlocks(text: string): string[] {
  return [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
}

/** Bash-блоки розділу `## <title>` README або документа з `docs/`. */
function blocks(title: string, file = 'README.md'): string[] {
  const docs = readFileSync(join(ROOT, file), 'utf8');
  const section = docs.split(`\n## ${title}\n`)[1]?.split('\n## ')[0] ?? '';
  return bashBlocks(section);
}

/** Усі bash-блоки документа. */
function allBlocks(file: string): string[] {
  return bashBlocks(readFileSync(join(ROOT, file), 'utf8'));
}

/** Сервіси штатного `docker-compose.yml` (ключі другого рівня розділу `services`). */
function composeServices(): string[] {
  const compose = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');
  const section = compose.split(/^services:\n/m)[1]?.split(/^\S/m)[0] ?? '';
  return [...section.matchAll(/^ {2}([a-z0-9-]+):/gm)].map((m) => m[1]);
}

/**
 * Виконує блок з кореня тимчасового репозиторію в чистому оточенні з фейковими npm і docker:
 * npm записує аргументи й ключі з `.env`, що дійшли до нього через оточення, docker — аргументи
 * (рядок `docker …`), у тому самому порядку, що й виклики.
 */
function runFresh(block: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'ff-readme-'));
  try {
    mkdirSync(join(dir, 'apps/api/scripts'), { recursive: true });
    writeFileSync(join(dir, 'apps/api/.env.example'), '');
    writeFileSync(
      join(dir, DB_URL_SCRIPT),
      readFileSync(join(ROOT, DB_URL_SCRIPT)),
    );
    writeFileSync(
      join(dir, 'docker'),
      '#!/bin/bash\nprintf "docker %s\\n" "$*" >> "$HOME/seen"\n',
      { mode: 0o700 },
    );
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

  it('passes the owner password from the root .env to the claim benchmark', () => {
    const [block] = allBlocks('docs/operations.md').filter((b) =>
      b.includes('bench:claim'),
    );
    expect(block).toBeDefined();
    expect(runFresh(block)).toContain('run bench:claim POSTGRES_PASSWORD');
  });

  /**
   * Будь-яка інструкція, що мігрує БД після зупинки сервісів, зупиняє їх усі: процес, який
   * лишився зі старою версією (як `api-2`, доданий пізніше за інструкцію), писав би в БД під час
   * міграції. Перелік сервісів — з `docker-compose.yml`, тож новий сервіс перевіряється сам.
   */
  it('stops every Compose service before a documented migration', () => {
    const services = composeServices();
    expect(services).toEqual(
      expect.arrayContaining(['postgres', 'migrate', 'api', 'api-2', 'worker']),
    );
    const migrates = (b: string) => /\bmigrate\b|\bup\b.*--build/.test(b);
    // Блоки розділів «Оновлення …» мігрують наявну БД, тож зупинка обов'язкова й без `stop` у
    // блоці; поза ними — кожен блок, що зупиняє сервіси перед міграцією.
    const upgrades = DOC_FILES.flatMap((file) =>
      readFileSync(join(ROOT, file), 'utf8')
        .split(/\n(?=#{2,3} )/)
        .filter((section) => /^#{2,3} Оновлення/.test(section))
        .flatMap(bashBlocks),
    ).filter(migrates);
    expect(upgrades.length).toBeGreaterThan(0);
    const migrating = [
      ...new Set([
        ...upgrades,
        ...DOC_FILES.flatMap(allBlocks).filter(
          (b) => /docker compose\b.*\bstop\b/.test(b) && migrates(b),
        ),
      ]),
    ];
    expect(migrating.length).toBeGreaterThan(0);
    for (const block of migrating) {
      const calls = runFresh(block);
      const stop = calls.findIndex((c) =>
        /^docker compose\b.*\bstop\b/.test(c),
      );
      const migration = calls.findIndex((c) =>
        /\bmigrate\b|^docker compose\b.*\bup\b.*--build/.test(c),
      );
      expect(stop).toBeGreaterThanOrEqual(0);
      expect(stop).toBeLessThan(migration);
      const named = calls[stop]
        .replace(/^docker compose\b.*?\bstop\b/, '')
        .split(/\s+/)
        .filter((arg) => arg && !arg.startsWith('-'));
      // Без переліку `compose stop` зупиняє всі сервіси проєкту.
      if (named.length > 0)
        expect(named).toEqual(expect.arrayContaining(services));
    }
  });

  it('gives no commands for the unsupported upgrade of a starter database', () => {
    for (const file of DOC_FILES)
      for (const block of allBlocks(file))
        expect(block).not.toMatch(/INSERT INTO migrations|InitialSchema\d+/);
  });

  it('prints the test database URL from the root .env wherever it is called from', () => {
    const run = (env: string | null) => {
      const dir = mkdtempSync(join(tmpdir(), 'ff-dburl-'));
      try {
        mkdirSync(join(dir, 'apps/api/scripts'), { recursive: true });
        writeFileSync(
          join(dir, DB_URL_SCRIPT),
          readFileSync(join(ROOT, DB_URL_SCRIPT)),
        );
        if (env !== null) writeFileSync(join(dir, '.env'), env);
        return execFileSync(process.execPath, [join(dir, DB_URL_SCRIPT)], {
          cwd: tmpdir(),
          env: { PATH: process.env.PATH },
          encoding: 'utf8',
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    expect(run(null)).toBe(
      'postgres://flowforge:flowforge@localhost:5432/flowforge_test',
    );
    expect(run("POSTGRES_PASSWORD='p@ss/w:rd #1'\nPOSTGRES_PORT=5544\n")).toBe(
      'postgres://flowforge:p%40ss%2Fw%3Ard%20%231@localhost:5544/flowforge_test',
    );
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

  it('documents discarding a disputed outbox backlog before recreating settings and starting workers', () => {
    const docs = readFileSync(
      join(__dirname, '../../../../docs/operations.md'),
      'utf8',
    );
    const upgrade = docs
      .split('\n### Оновлення з першої версії outbox\n')[1]
      ?.split('\n### ')[0];
    expect(upgrade).toMatch(
      /запустіть лише API[\s\S]*`POST \/tenants\/me\/notifications\/events\/discard`[\s\S]*`PUT \/tenants\/me\/notifications`[\s\S]*запустіть воркери/iu,
    );
  });
});
