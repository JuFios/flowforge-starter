import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('passes only the secrets needed by each documented local command, the frontend none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-local-'));
  const docs = readFileSync(
    join(__dirname, '../../../../docs/operations.md'),
    'utf8',
  )
    .split('### Локальний запуск поза docker')[1]
    .split('### Оновлення')[0];
  const blocks = [...docs.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
  const keys = [
    'POSTGRES_PASSWORD',
    'API_DB_PASSWORD',
    'WORKER_DB_PASSWORD',
    'ADMIN_TOKEN',
  ];
  try {
    mkdirSync(join(dir, 'apps/api'), { recursive: true });
    writeFileSync(
      join(dir, '.env'),
      keys.map((k) => 'export ' + k + '=marker' + k).join('\n'),
    );
    writeFileSync(join(dir, 'apps/api/.env.example'), '');
    mkdirSync(join(dir, 'apps/frontend'), { recursive: true });
    writeFileSync(
      join(dir, 'apps/frontend/.env.example'),
      'API_URLS=http://api:3000,http://api-2:3000\nAPI_TIMEOUT_MS=15000\n',
    );
    writeFileSync(join(dir, 'docker'), '#!/bin/sh\nexit 0\n', {
      mode: 0o700,
    });
    writeFileSync(
      join(dir, 'npm'),
      '#!/bin/bash\nprintf "%s " "$*" >> "$HOME/seen"\nfor k in ' +
        keys.join(' ') +
        '; do if env | grep -q "=.*marker$k"; then printf "%s " "$k" >> "$HOME/seen"; fi; done\necho >> "$HOME/seen"\n',
      { mode: 0o700 },
    );
    // API з кореня, воркер з apps/api, фронтенд з кореня — як у тексті перед кожним блоком.
    expect(blocks).toHaveLength(3);
    for (const [i, block] of blocks.entries())
      execFileSync('bash', ['-eu', '-c', block], {
        cwd: i === 1 ? join(dir, 'apps/api') : dir,
        env: { PATH: dir + ':' + process.env.PATH, HOME: dir },
      });
    expect(
      readFileSync(join(dir, 'seen'), 'utf8')
        .trim()
        .split('\n')
        .map((s) => s.trim()),
    ).toEqual([
      'ci',
      'run build',
      'run db:migrate POSTGRES_PASSWORD',
      'run db:provision POSTGRES_PASSWORD API_DB_PASSWORD WORKER_DB_PASSWORD',
      'run start API_DB_PASSWORD ADMIN_TOKEN',
      'run start:worker WORKER_DB_PASSWORD',
      'ci',
      'run dev -- -p 3001',
    ]);
    // Локальний фронтенд ходить до єдиного локального API, а не до адрес мережі compose.
    expect(readFileSync(join(dir, 'apps/frontend/.env.local'), 'utf8')).toBe(
      'API_URLS=http://localhost:3000\nAPI_TIMEOUT_MS=15000\n',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
