import { registerDecorator, ValidationOptions } from 'class-validator';

/**
 * Облікові дані, які генерує клієнт (ТЗ 4: секрети не потрапляють у відповіді API). Сервер їх не
 * видає: API-ключ і ключі підпису приходять у тілі запиту, зберігаються (API-ключ — лише sha256) і
 * далі ніде не повертаються. Генерувати їх належить криптографічно стійким джерелом, наприклад
 * `openssl rand -hex 32` (docs/operations.md, «Облікові дані тенанта»).
 *
 * Сервер не може виміряти ентропію значення, тож межі відсікають очевидні помилки: закороткі
 * значення, недруковані символи й заповнювачі з кількох повторюваних символів. Повідомлення
 * валідації не містять самого значення.
 */

/** API-ключ: 43 символи base64url — це 32 випадкові байти; hex із префіксом теж проходить. */
export const API_KEY_PATTERN = /^[A-Za-z0-9_-]{43,256}$/;

/** Секрет підпису HMAC: друкований ASCII без пробілів, щонайменше 32 символи (16 байтів у hex). */
export const SIGNING_SECRET_PATTERN = /^[\x21-\x7e]{32,256}$/;

/** Найменша кількість різних символів: «aaaa…» чи «0101…» не є випадковим значенням. */
export const MIN_DISTINCT_CHARACTERS = 8;

export function isKeyMaterial(value: unknown, pattern: RegExp): boolean {
  return (
    typeof value === 'string' &&
    pattern.test(value) &&
    new Set(value).size >= MIN_DISTINCT_CHARACTERS
  );
}

function keyMaterial(
  pattern: RegExp,
  message: string,
  options?: ValidationOptions,
): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'isKeyMaterial',
      target: target.constructor,
      propertyName: propertyName as string,
      options: { message, ...options },
      validator: {
        validate: (value: unknown) => isKeyMaterial(value, pattern),
      },
    });
  };
}

/** API-ключ тенанта, згенерований клієнтом. */
export const IsApiKeyMaterial = (options?: ValidationOptions) =>
  keyMaterial(
    API_KEY_PATTERN,
    '$property must be 43-256 characters [A-Za-z0-9_-] with at least 8 distinct characters',
    options,
  );

/** Секрет підпису (webhook чи сповіщення), згенерований клієнтом. */
export const IsSigningSecret = (options?: ValidationOptions) =>
  keyMaterial(
    SIGNING_SECRET_PATTERN,
    '$property must be 32-256 printable ASCII characters without spaces, at least 8 distinct',
    options,
  );

/** Тіло ротації ключа підпису: новий секрет `next`, згенерований клієнтом. */
export class SigningSecretDto {
  @IsSigningSecret()
  secret: string;
}
