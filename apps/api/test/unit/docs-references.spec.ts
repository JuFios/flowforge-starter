import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_DETAIL_BYTES } from '../../src/executions/detail-limits';

/**
 * Узгодженість документації з кодом і між файлами: текстові посилання з прикладів env ведуть на
 * наявні розділи, а правила, з якими процес не стартує, перелічені там, де оператор їх звіряє.
 */
const ROOT = join(__dirname, '../../../..');
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');
const ENV_EXAMPLES = [
  '.env.example',
  'apps/api/.env.example',
  'apps/frontend/.env.example',
];

describe('documentation references', () => {
  it('points every env example reference at an existing section', () => {
    const references = ENV_EXAMPLES.flatMap((file) =>
      [
        ...read(file).matchAll(
          /\b(README|docs\/[\w-]+\.md)(?:,)?\s+«([^»]+)»/g,
        ),
      ].map(([, doc, title]) => ({
        file,
        doc: doc === 'README' ? 'README.md' : doc,
        title,
      })),
    );
    expect(references.length).toBeGreaterThan(0);
    for (const { file, doc, title } of references) {
      const target = read(doc);
      const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const heading = new RegExp(`^#+ ${escaped}(?: \\(|$)`, 'm');
      const term = new RegExp(`\\*\\*${escaped}\\.\\*\\*`);
      expect({
        file,
        doc,
        title,
        found: heading.test(target) || term.test(target),
      }).toEqual({ file, doc, title, found: true });
    }
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
});
