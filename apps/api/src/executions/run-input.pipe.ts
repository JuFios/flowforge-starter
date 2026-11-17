import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

/** Найбільший розмір вхідних даних виконання (JSON), байт. Зберігається в executions.input. */
export const MAX_RUN_INPUT_BYTES = 64 * 1024;

/**
 * Вхід виконання (тіло `POST /workflows/:id/run`, тіло webhook-а): JSON-об'єкт обмеженого
 * розміру. Порожнє тіло — порожній об'єкт.
 */
@Injectable()
export class RunInputPipe implements PipeTransform {
  transform(value: unknown): Record<string, unknown> {
    if (value === undefined || value === null) return {};
    if (typeof value !== 'object' || Array.isArray(value))
      throw new BadRequestException(
        "вхідні дані виконання мають бути JSON-об'єктом",
      );
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_RUN_INPUT_BYTES)
      throw new BadRequestException(
        `вхідні дані виконання більші за ${MAX_RUN_INPUT_BYTES} байт`,
      );
    return value as Record<string, unknown>;
  }
}
