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

/**
 * Зводить помилку до безпечного набору полів: тип, повідомлення, код (SQLSTATE тощо) і стек.
 * Решта полів свідомо відкидається: у QueryFailedError це текст запиту, його параметри й
 * деталі драйвера (там можуть бути JSON кроків із заголовками авторизації), у HttpException —
 * `cause`. Редакція pino працює за шляхами полів і не бачить секретів усередині рядків.
 */
export function toSafeError(err: unknown): SafeError {
  if (!(err instanceof Error)) {
    return { type: typeof err, message: 'Non-Error value thrown' };
  }
  const code = errorCode(err);
  return { type: err.name, message: err.message, ...(code !== undefined && { code }), stack: err.stack };
}
