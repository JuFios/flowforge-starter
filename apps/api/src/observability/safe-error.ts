/** Те, що з помилки дозволено писати в лог. */
export interface SafeError {
  type: string;
  message: string;
  code?: string;
  stack?: string;
}

function errorCode(err: Error): string | undefined {
  const own = (err as { code?: unknown }).code;
  const driver = (err as { driverError?: { code?: unknown } }).driverError?.code;
  const code = own ?? driver;
  return typeof code === 'string' || typeof code === 'number' ? String(code) : undefined;
}

export const REDACTED = '[redacted]';

/** SQLSTATE: 5 символів [0-9A-Z] з хоча б однією цифрою (на відміну від кодів Node: EPIPE тощо). */
const SQLSTATE = /^(?=.*\d)[0-9A-Z]{5}$/;

/** Довше повідомлення драйвера обрізається: у хвості можуть бути фрагменти вхідних даних. */
export const MAX_DB_MESSAGE_LENGTH = 300;

/**
 * Місця, куди Postgres підставляє вхідне значення, а не ідентифікатор. Значення може містити
 * лапки й переведення рядка, тому береться все до кінця повідомлення / до відомого хвоста.
 * Ідентифікатори (relation "x", column "y", constraint "z") лишаються — вони потрібні для
 * діагностики й не походять від вводу.
 */
const VALUE_PATTERNS: Array<[RegExp, string]> = [
  // invalid input syntax for type uuid: "…", invalid input value for enum x: "…",
  // date/time field value out of range: "…", malformed array literal: "…"
  [/(: )"[\s\S]*"$/, `$1"${REDACTED}"`],
  // value "…" is out of range for type integer
  [/(value )"[\s\S]*"( is out of range)/, `$1"${REDACTED}"$2`],
  // syntax error at or near "…"
  [/(at or near )"[\s\S]*"$/, `$1"${REDACTED}"`],
  // invalid byte sequence for encoding "UTF8": 0xd0 0x3c
  [/(: )0x[0-9a-f]{2}(?: 0x[0-9a-f]{2})*/gi, `$1${REDACTED}`],
];

function isDatabaseError(err: Error, code: string | undefined): boolean {
  return err.name === 'QueryFailedError' || 'driverError' in err || (code !== undefined && SQLSTATE.test(code));
}

export function maskDatabaseMessage(message: string): string {
  let masked = VALUE_PATTERNS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), message);
  if (masked.length > MAX_DB_MESSAGE_LENGTH) masked = `${masked.slice(0, MAX_DB_MESSAGE_LENGTH)}…`;
  return masked;
}

/** Перший рядок стеку — `${name}: ${message}`; його теж треба замаскувати. */
function maskStack(err: Error, masked: string): string | undefined {
  if (!err.stack) return undefined;
  const header = `${err.name}: ${err.message}`;
  if (err.stack.startsWith(header)) return `${err.name}: ${masked}${err.stack.slice(header.length)}`;
  // Нестандартний стек: лишаємо тільки кадри викликів, без тексту повідомлення.
  const frames = err.stack.split('\n').filter((line) => /^\s+at /.test(line));
  return [`${err.name}: ${masked}`, ...frames].join('\n');
}

/**
 * Зводить помилку до безпечного набору полів: тип, повідомлення, код (SQLSTATE тощо) і стек.
 * Решта полів свідомо відкидається: у QueryFailedError це текст запиту, його параметри й
 * деталі драйвера (там можуть бути JSON кроків із заголовками авторизації), у HttpException —
 * `cause`. Редакція pino працює за шляхами полів і не бачить секретів усередині рядків.
 * У повідомленнях помилок БД вхідні значення маскуються (Postgres повторює їх у тексті,
 * напр. `invalid input syntax for type uuid: "…"`) — і в `message`, і в першому рядку стеку.
 */
export function toSafeError(err: unknown): SafeError {
  if (!(err instanceof Error)) {
    return { type: typeof err, message: 'Non-Error value thrown' };
  }
  const code = errorCode(err);
  const database = isDatabaseError(err, code);
  const message = database ? maskDatabaseMessage(err.message) : err.message;
  const stack = database ? maskStack(err, message) : err.stack;
  return { type: err.name, message, ...(code !== undefined && { code }), stack };
}
