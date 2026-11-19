import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

/**
 * Тести з вихідних TS запускають дочірній процес transform зі збірки `dist`. Якщо джерела пісочниці
 * відрізняються від зібраних файлів, тести перевіряли б стару версію, тож запуск зупиняється.
 * Порівнюється вміст (транспіляція з тими самими опціями), а не час зміни: інкрементальна збірка
 * не переписує файл, чий вміст не змінився.
 */
const SOURCES = [
  'engine/transform-child',
  'engine/transform-profile',
  'common/json-depth',
];

export default function freshTransformBuild(): void {
  const root = resolve(__dirname, '../..');
  const config = ts.parseJsonConfigFileContent(
    ts.readConfigFile(resolve(root, 'tsconfig.json'), (path) =>
      ts.sys.readFile(path),
    ).config,
    ts.sys,
    root,
  );
  for (const name of SOURCES) {
    const expected = ts
      .transpileModule(
        readFileSync(resolve(root, 'src', name + '.ts'), 'utf8'),
        {
          compilerOptions: {
            ...config.options,
            sourceMap: false,
            inlineSourceMap: false,
            declaration: false,
          },
          fileName: name + '.ts',
        },
      )
      .outputText.trim();
    let built = '';
    try {
      built = readFileSync(resolve(root, 'dist', name + '.js'), 'utf8')
        .replace(/\n\/\/# sourceMappingURL=.*\n?$/, '\n')
        .trim();
    } catch {
      // Немає збірки — та сама відмова нижче.
    }
    if (built !== expected)
      throw new Error(
        `dist/${name}.js is missing or differs from src/${name}.ts: run npm run build first`,
      );
  }
}
