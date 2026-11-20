import { toStorableText } from './storable-text';

/**
 * Числа JSON, які змінилися б до збереження. `JSON.parse` перетворює кожне число на double:
 * `1e400` стає `Infinity` (а `JSON.stringify` — `null`), `12345678901234567890` —
 * `12345678901234567000`. Тож перевіряти треба сирий текст, поки він є: після розбору різниці
 * вже не видно (Node 20 не передає джерело числа в reviver).
 *
 * Число точне, якщо `JSON.stringify` розібраного значення дає те саме десяткове число, що й
 * надіслане: `0.1`, `1.0`, `1e2`, `-0` точні (збережений JSON означає те саме число), а
 * `1e400` і цілі поза точністю double — ні.
 */

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const ZERO = 0x30;
/** Найдовший шлях у повідомленні про помилку: ключі надсилає клієнт. */
const MAX_PATH_LENGTH = 200;
const PLAIN_KEY = /^[A-Za-z_$][\w$]*$/;

/** Десяткове число у вигляді `[-]цифри e порядок` (0.цифри × 10^порядок), нуль — `0`. */
function canonical(token: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (!match) return `invalid:${token}`;
  const [, sign, whole, fraction = '', exponent = '0'] = match;
  const digits = whole + fraction;
  // Нулі з обох боків — лінійними циклами, а не регулярним виразом: `/0+$/` бектрекує
  // квадратично на довгому ряді нулів посередині, а сканер працює до автентифікації.
  let start = 0;
  while (start < digits.length && digits.charCodeAt(start) === ZERO) start++;
  let end = digits.length;
  while (end > start && digits.charCodeAt(end - 1) === ZERO) end--;
  if (start === end) return '0';
  // Порядок як рядок цифр великої довжини міг би вийти за межі Number: такий токен однаково
  // неточний (Infinity або 0 після розбору), тож його порівняння з результатом розбору впаде.
  const point = whole.length + Number(exponent) - start;
  return `${sign}${digits.slice(start, end)}e${point}`;
}

/** Чи дає розібране значення токена те саме десяткове число. */
export function isExactJsonNumber(token: string): boolean {
  const value = Number(token);
  if (!Number.isFinite(value)) return false;
  return canonical(String(value)) === canonical(token);
}

interface Frame {
  array: boolean;
  /** Індекс елемента масиву або ключ поточного поля об'єкта. */
  index: number;
  key: string | undefined;
  /** Об'єкт чекає на ключ (після `{` або `,`). */
  expectKey: boolean;
}

/**
 * JSON-шлях: простий ключ — `.key`, інший (з `.`, `[`, пробілом тощо) — `["…"]`, щоб шлях
 * однозначно вказував на поле. Обрізається до MAX_PATH_LENGTH: ключі надсилає клієнт.
 */
function pathOf(stack: Frame[]): string {
  let path = '$';
  for (const frame of stack) {
    if (frame.array) path += `[${frame.index}]`;
    else if (frame.key !== undefined)
      path += PLAIN_KEY.test(frame.key)
        ? `.${frame.key}`
        : `[${JSON.stringify(toStorableText(frame.key))}]`;
    if (path.length > MAX_PATH_LENGTH)
      return `${path.slice(0, MAX_PATH_LENGTH)}…`;
  }
  return path;
}

/**
 * JSON-шлях (`$.a[1].b`) до першого неточного числа в тексті JSON або undefined. Лінійний прохід
 * без рекурсії: глибина не обмежена стеком викликів. Невалідний JSON не відхиляється тут —
 * про нього скаже розбір (сканер лише не падає).
 */
export function findInexactNumber(text: string): string | undefined {
  const stack: Frame[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const top = stack[stack.length - 1];
    switch (ch) {
      case '{':
      case '[':
        stack.push({
          array: ch === '[',
          index: 0,
          key: undefined,
          expectKey: ch === '{',
        });
        i++;
        continue;
      case '}':
      case ']':
        stack.pop();
        i++;
        continue;
      case ',':
        if (top?.array) top.index++;
        else if (top) top.expectKey = true;
        i++;
        continue;
      case '"': {
        let end = i + 1;
        while (end < text.length && text[end] !== '"')
          end += text[end] === '\\' ? 2 : 1;
        if (top && !top.array && top.expectKey) {
          try {
            top.key = JSON.parse(text.slice(i, end + 1)) as string;
          } catch {
            return undefined;
          }
          top.expectKey = false;
        }
        i = end + 1;
        continue;
      }
      default:
        if (ch === '-' || (ch >= '0' && ch <= '9')) {
          NUMBER.lastIndex = i;
          const match = NUMBER.exec(text);
          if (!match) return undefined;
          if (!isExactJsonNumber(match[0])) return pathOf(stack);
          i += match[0].length;
          continue;
        }
        // Пробіли, `:`, true/false/null; решта — невалідний JSON, його відхилить розбір.
        i++;
    }
  }
  return undefined;
}

/** Повідомлення 400 для неточного числа. */
export function inexactNumberMessage(path: string): string {
  return `число ${path} неможливо зберегти без зміни значення (поза діапазоном або точністю double)`;
}
