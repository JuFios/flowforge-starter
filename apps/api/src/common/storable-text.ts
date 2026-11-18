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
 * або undefined, якщо таких немає. Обхід у глибину з явним стеком (не рекурсія): глибина
 * вкладеності не обмежена стеком викликів. Ключ перевіряється перед своїм значенням.
 */
export function findUnstorable(value: unknown, path = '$'): string | undefined {
  const stack: Array<{ item: unknown; where: string }> = [
    { item: value, where: path },
  ];
  for (let next = stack.pop(); next; next = stack.pop()) {
    const { item, where } = next;
    if (typeof item === 'string') {
      if (!isStorableText(item)) return where;
      continue;
    }
    if (typeof item !== 'object' || item === null) continue;
    // У стек — у зворотному порядку, щоб діставати в прямому (як рекурсивний обхід).
    if (Array.isArray(item)) {
      for (let i = item.length - 1; i >= 0; i--)
        stack.push({ item: item[i] as unknown, where: `${where}[${i}]` });
      continue;
    }
    const entries = Object.entries(item as Record<string, unknown>);
    for (let i = entries.length - 1; i >= 0; i--) {
      const [key, child] = entries[i];
      const at = `${where}.${toStorableText(key)}`;
      stack.push({ item: child, where: at }, { item: key, where: at });
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
  const json = JSON.stringify(value ?? null) ?? 'null';
  let replaced = 0;
  // JSON.stringify екранує NUL і одиночні сурогати як \uXXXX, а коректні пари
  // лишає символами Unicode. Пари зворотних скісних рисок пропускаємо разом:
  // буквальний текст «\u0000» має зберегтися. Однаково обробляються ключі та значення.
  const sanitized = json.replace(
    /\\\\|\\u(?:0000|d[89a-f][0-9a-f]{2})/g,
    (escape) => {
      if (escape.length === 2) return escape;
      replaced++;
      return REPLACEMENT_CHARACTER;
    },
  );
  return { value: JSON.parse(sanitized) as unknown, replaced };
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
