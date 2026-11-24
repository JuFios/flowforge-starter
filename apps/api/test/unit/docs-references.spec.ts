import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_DETAIL_BYTES } from '../../src/executions/detail-limits';

/**
 * Узгодженість документації з кодом і між файлами: текстові посилання з коду, конфігурації й самої
 * документації ведуть на наявні розділи; довідники описують кожну метрику, змінну оточення,
 * перевизначення ліміту й перевірений планом індекс; правила, з якими процес не стартує,
 * перелічені там, де оператор їх звіряє.
 */
const ROOT = join(__dirname, '../../../..');
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');
const ENV_EXAMPLES = [
  '.env.example',
  'apps/api/.env.example',
  'apps/frontend/.env.example',
];
const DOCS = ['README.md', 'docs/operations.md', 'docs/architecture.md'];

/** Файли репозиторію, у коментарях яких можуть бути посилання на документацію. */
function sourceFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap(
    (entry) => {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory())
        return ['node_modules', 'dist', '.next'].includes(entry.name)
          ? []
          : sourceFiles(path);
      return /\.(ts|tsx|cjs|mjs|js|ya?ml)$/.test(entry.name) ? [path] : [];
    },
  );
}

/** Розділ документа від заголовка до наступного заголовка того самого чи вищого рівня. */
function section(doc: string, heading: string): string {
  const text = read(doc);
  const start = text.search(new RegExp(`^${heading}$`, 'm'));
  expect({ doc, heading, found: start >= 0 }).toEqual({
    doc,
    heading,
    found: true,
  });
  const level = /^#+/.exec(heading)?.[0].length ?? 2;
  const rest = text.slice(start + heading.length);
  // Коментарі «# …» у блоках коду — не заголовки: блоки маскуються тієї самої довжини.
  const prose = rest.replace(/^```[\s\S]*?^```/gm, (block) =>
    block.replace(/[^\n]/g, ' '),
  );
  const end = prose.search(new RegExp(`^#{1,${level}} `, 'm'));
  return end < 0 ? rest : rest.slice(0, end);
}

/** Перша markdown-таблиця після виділеного терміна: її рядки поспіль. */
function tableAfter(doc: string, term: string): string[] {
  const after = read(doc).split(term)[1] ?? '';
  const lines = after.split('\n');
  const first = lines.findIndex((line) => line.startsWith('|'));
  expect({ doc, term, table: first >= 0 }).toEqual({ doc, term, table: true });
  const rest = lines.slice(first);
  const end = rest.findIndex((line) => !line.startsWith('|'));
  return end < 0 ? rest : rest.slice(0, end);
}

/** Рядки markdown-таблиць розділу. */
const tableRows = (text: string) =>
  text.split('\n').filter((line) => line.startsWith('|'));

describe('documentation references', () => {
  /**
   * Посилання на README чи docs/*.md з назвою розділу в лапках-ялинках (зокрема з номером пункту
   * ТЗ між ними) у коментарях коду, тестів, CI, compose, прикладів env і в самій документації:
   * розділ має бути заголовком або виділеним терміном саме в названому документі, а не в сусідньому.
   */
  it('points every named section reference at a section of that document', () => {
    const files = [
      ...ENV_EXAMPLES,
      ...DOCS,
      'docker-compose.yml',
      'docker-compose.chaos.yml',
      ...sourceFiles('.github'),
      ...sourceFiles('apps/api/src'),
      ...sourceFiles('apps/api/test'),
      ...sourceFiles('apps/api/scripts'),
      ...['app', 'components', 'lib', 'test'].flatMap((dir) =>
        sourceFiles(`apps/frontend/${dir}`),
      ),
      'apps/frontend/server.ts',
    ];
    const references = files.flatMap((file) =>
      [
        ...read(file).matchAll(
          /\b(README(?:\.md)?|docs\/[\w-]+\.md)(?:,?\s*\d+(?:\.\d+)*)?,?\s+«([^»]+)»/g,
        ),
      ].map(([, doc, title]) => ({
        file,
        doc: doc.startsWith('README') ? 'README.md' : doc,
        // Назва, перенесена в коментарі чи markdown на новий рядок: без « * », «# » і «// ».
        title: title.replace(/\s*\n\s*(?:\*|#|\/\/)?\s*/g, ' '),
      })),
    );
    expect(references.length).toBeGreaterThan(20);
    const broken = references.filter(({ doc, title }) => {
      const target = read(doc);
      const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const heading = new RegExp(`^#+ ${escaped}(?: \\(|$)`, 'm');
      const term = new RegExp(`\\*\\*${escaped}\\.\\*\\*`);
      return !heading.test(target) && !term.test(target);
    });
    expect(broken).toEqual([]);
  });

  it('states the largest execution snapshot in MiB wherever the disk budget rule is explained', () => {
    const mib = MAX_DETAIL_BYTES / 2 ** 20;
    expect(Number.isInteger(mib)).toBe(true);
    for (const file of ['docs/operations.md', 'apps/api/.env.example']) {
      const text = read(file);
      expect(text).toContain(`найбільший знімок (~${mib} МіБ)`);
      expect(text).not.toMatch(/найбільший знімок \(~\d+ МБ\)/);
    }
  });

  /**
   * Кожне правило «X не менше за k × Y» з env.validation.ts зупиняє старт процесу. Абзац перевірки
   * перед оновленням має перелічити всі такі правила, інакше оновлення з власними значеннями
   * впаде на старті.
   */
  it('lists every cross-field startup rule in the pre-upgrade check', () => {
    const source = readFileSync(
      join(__dirname, '../../src/config/env.validation.ts'),
      'utf8',
    );
    const rules = [
      ...source.matchAll(
        /@IsAtLeastTimes\('([A-Z_]+)',[^)]*\)\s*(?:@[^\n]*\n\s*)*([A-Z_]+)\s*[=!:]/g,
      ),
    ].map(([, other, name]) => ({ name, other }));
    expect(rules.map((r) => r.name)).toEqual(
      expect.arrayContaining([
        'REALTIME_MAX_CONNECTIONS',
        'DETAIL_MAX_CONCURRENT',
        'DETAIL_DISK_BUDGET_BYTES',
      ]),
    );
    const upgrade =
      read('docs/operations.md')
        .split('\n### Оновлення з попередньої версії\n')[1]
        ?.split('```bash')[0] ?? '';
    for (const { name, other } of rules)
      expect(upgrade).toMatch(
        new RegExp(`\`${name}\`\\s+менше\\s+за\\s+2\\s+×\\s+\`${other}\``),
      );
  });

  it('describes every registered metric in the operations guide', () => {
    const names = sourceFiles('apps/api/src').flatMap((file) =>
      [...read(file).matchAll(/name: '(flowforge_[a-z_]+)'/g)].map(
        ([, name]) => name,
      ),
    );
    expect(names.length).toBeGreaterThan(30);
    const observability = section('docs/operations.md', '## Спостережуваність');
    const missing = names.filter(
      (name) => !observability.includes(`\`${name}`),
    );
    expect(missing).toEqual([]);
  });

  /**
   * Довідник конфігурації — таблиці розділу «Конфігурація»: кожна змінна, яку читає схема API й
   * воркера, вихідний транспорт, сервер фронтенду чи будь-який приклад env, має свій рядок.
   */
  it('gives every configuration variable a row in the configuration reference', () => {
    const schema = read('apps/api/src/config/env.validation.ts');
    const names = new Set([
      ...ENV_EXAMPLES.flatMap((file) =>
        [...read(file).matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map(
          ([, name]) => name,
        ),
      ),
      ...[
        ...schema.matchAll(
          /^ {2}([A-Z][A-Z0-9_]+)[?!]?(?::[^=;\n]+)?\s*[=;]/gm,
        ),
      ].map(([, name]) => name),
      ...[
        ...read('apps/api/src/engine/outbound-http.ts')
          .split('SETTING_NAMES = [')[1]
          .split(']')[0]
          .matchAll(/'([A-Z_]+)'/g),
      ].map(([, name]) => name),
      ...[
        'apps/frontend/lib/server-config.ts',
        'apps/frontend/server.ts',
      ].flatMap((file) =>
        [
          ...read(file).matchAll(
            /(?:process\.env\.|(?:int|bool)\(')([A-Z][A-Z0-9_]+)/g,
          ),
        ].map(([, name]) => name),
      ),
    ]);
    expect(names.size).toBeGreaterThan(60);
    for (const name of [
      'HTTP_FIXTURE_ORIGIN',
      'API_TIMEOUT_MS',
      'SESSION_TTL_MS',
    ])
      expect(names.has(name)).toBe(true);
    const rows = tableRows(section('docs/operations.md', '## Конфігурація'));
    const missing = [...names].filter(
      (name) => !rows.some((row) => row.includes(`\`${name}\``)),
    );
    expect(missing).toEqual([]);
  });

  it('lists every tenant limit override in the limits contract', () => {
    const overrides = [
      ...read('apps/api/src/tenants/tenant-limits.dto.ts').matchAll(
        /^ {2}(\w+)\?: number \| null;/gm,
      ),
    ].map(([, name]) => name);
    expect(overrides).toContain('maxWorkflows');
    const contract = tableAfter(
      'docs/architecture.md',
      '**Контракт лімітів.**',
    );
    const missing = overrides.filter(
      (name) => !contract.some((row) => row.includes(`\`${name}\``)),
    );
    expect(missing).toEqual([]);
  });

  it('lists every index the query plan tests require in both index tables', () => {
    const indexes = new Set(
      [
        'apps/api/test/integration/query-plans.int-spec.ts',
        'apps/api/test/integration/scheduler-outbox-plans.int-spec.ts',
      ].flatMap((file) =>
        [...read(file).matchAll(/'((?:IDX|UQ)_[A-Za-z_]+)'/g)].map(
          ([, name]) => name,
        ),
      ),
    );
    expect(indexes.size).toBeGreaterThan(10);
    for (const doc of ['README.md', 'docs/architecture.md']) {
      const rows = tableRows(section(doc, '## Індекси і плани запитів'));
      const missing = [...indexes].filter(
        (name) => !rows.some((row) => row.includes(`\`${name}\``)),
      );
      expect({ doc, missing }).toEqual({ doc, missing: [] });
    }
  });
});
