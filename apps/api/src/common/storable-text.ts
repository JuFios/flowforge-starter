import { ValidateBy, ValidationOptions } from 'class-validator';

/**
 * Те, чого Postgres не зберігає: U+0000 (ні в `text`, ні в `jsonb`) і одиночні сурогати UTF-16
 * (`jsonb` відкидає `\ud800` без пари; у `text` драйвер мовчки перетворив би їх на U+FFFD).
 * Регулярний вираз без прапорця `u` працює з кодовими одиницями UTF-16 — саме так і треба.
 */
const UNSTORABLE =
  // eslint-disable-next-line no-control-regex -- U+0000 і є символом, який треба знайти
  /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Символ заміни Unicode — стандартна заміна символу, який неможливо подати. */
export const REPLACEMENT_CHARACTER = '�';

export function isStorableText(text: string): boolean {
  UNSTORABLE.lastIndex = 0;
  return !UNSTORABLE.test(text);
}

/**
 * Шлях (`$.a[1].b`) до першого рядка — ключа чи значення — з символом, який Postgres не зберігає,
 * або undefined, якщо таких немає.
 */
export function findUnstorable(value: unknown, path = '$'): string | undefined {
  if (typeof value === 'string')
    return isStorableText(value) ? undefined : path;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findUnstorable(value[i], `${path}[${i}]`);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      const where = `${path}.${toStorableText(key)}`;
      if (!isStorableText(key)) return where;
      const found = findUnstorable(item, where);
      if (found) return found;
    }
  }
  return undefined;
}

/** Рядок, придатний для збереження: кожен проблемний символ замінено на U+FFFD. */
export function toStorableText(text: string): string {
  return text.replace(UNSTORABLE, REPLACEMENT_CHARACTER);
}

export interface Storable<T> {
  value: T;
  /** Скільки символів замінено. */
  replaced: number;
}

/**
 * JSON-значення в тому вигляді, в якому його збереже `jsonb`, з кожним проблемним символом у
 * ключах і рядках, заміненим на U+FFFD. Спершу значення проходить через JSON (toJSON, Date,
 * undefined у масивах — так само, як при записі), тож результат — прості дані, які збігаються зі
 * збереженими. Якщо два ключі після заміни збіглися, лишається останній (як у JSON.parse).
 */
export function toStorable(value: unknown): Storable<unknown> {
  let replaced = 0;
  const text = (s: string): string =>
    s.replace(UNSTORABLE, () => {
      replaced += 1;
      return REPLACEMENT_CHARACTER;
    });
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return text(v);
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === 'object' && v !== null)
      return Object.fromEntries(
        Object.entries(v).map(([k, item]) => [text(k), walk(item)]),
      );
    return v;
  };
  const json = JSON.stringify(value ?? null) ?? 'null';
  return { value: walk(JSON.parse(json)), replaced };
}

/** Рядок без символів, яких Postgres не зберігає (U+0000, одиночні сурогати). */
export function IsStorableText(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isStorableText',
      validator: {
        validate: (value: unknown) =>
          typeof value !== 'string' || isStorableText(value),
        defaultMessage: (args) =>
          `${args?.property ?? 'значення'} містить символ U+0000 або некоректний Unicode (одиночний сурогат)`,
      },
    },
    options,
  );
}
