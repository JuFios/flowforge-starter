import { MAX_RESPONSE_BYTES } from '../config/outbound';
import { MAX_STEPS } from '../workflows/step-limits';

/**
 * Найбільший знімок `GET /executions/:id`, байт. Текстова HTTP-відповідь може розширитись до шести
 * байтів на символ після JSON-екранування. Вихід останнього кроку повторюється в execution.output.
 * Запас охоплює решту полів та вхід.
 */
export const MAX_DETAIL_BYTES = ((MAX_STEPS + 1) * 6 + 2) * MAX_RESPONSE_BYTES;

/** Через скільки секунд повторити запит деталей після тимчасової відмови (429/503). */
export const DETAIL_RETRY_AFTER_SECONDS = 1;
