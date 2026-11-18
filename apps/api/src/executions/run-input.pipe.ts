import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { findUnstorable } from '../common/storable-text';

/** Найбільший розмір вхідних даних виконання (JSON), байт. Зберігається в executions.input. */
export const MAX_RUN_INPUT_BYTES = 64 * 1024;

/**
 * Вхід виконання (тіло `POST /workflows/:id/run`, тіло webhook-а): JSON-об'єкт обмеженого
 * розміру. Порожнє тіло — порожній об'єкт. Кидає BadRequestException з поясненням.
 */
export function parseRunInput(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value))
    throw new BadRequestException(
      "вхідні дані виконання мають бути JSON-об'єктом",
    );
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_RUN_INPUT_BYTES)
    throw new BadRequestException(
      `вхідні дані виконання більші за ${MAX_RUN_INPUT_BYTES} байт`,
    );
  const unstorable = findUnstorable(value);
  if (unstorable)
    throw new BadRequestException(
      `вхідні дані виконання: рядок ${unstorable} містить символ U+0000 або некоректний Unicode (одиночний сурогат)`,
    );
  return value as Record<string, unknown>;
}

/**
 * parseRunInput як пайп — для ендпоінтів, де автентифікація (guard) уже відбулася до пайпів.
 * Webhook автентифікується підписом у самому обробнику, тож викликає parseRunInput після нього.
 */
@Injectable()
export class RunInputPipe implements PipeTransform {
  transform(value: unknown): Record<string, unknown> {
    return parseRunInput(value);
  }
}
