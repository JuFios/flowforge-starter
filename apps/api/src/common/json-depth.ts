/**
 * Найбільша вкладеність JSON (об'єкти й масиви) у тілах запитів API і в результатах кроків.
 * Рекурсивні обходи (JSON.stringify у V8, class-transformer, перевірки символів) переповнюють
 * стек уже на кількох тисячах рівнів — на вході, меншому за ліміт тіла. Межа з великим запасом
 * перевищує глибину реальних payload-ів webhook-ів і API.
 */
export const MAX_JSON_DEPTH = 64;

/**
 * Найбільша вкладеність результату кроку (JSON-відповідь отримувача). Вища за MAX_JSON_DEPTH:
 * відповідь задає не тенант, і обрізати чи відхиляти звичайні глибокі структури не можна. Межа —
 * утричі нижча за глибину, на якій JSON.stringify у V8 (Node 20) переповнює стек (~6100 рівнів
 * без запасу стека), і вчетверо нижча за межу `jsonb` у Postgres (8192 зберігає, 20 000 — ні).
 */
export const MAX_STEP_RESULT_DEPTH = 2048;

/**
 * Чи вкладене значення глибше за `max` рівнів (`{}` і `[]` — один рівень, примітив — нуль).
 * Ітеративно, з явним стеком: глибина входу не обмежена стеком викликів.
 */
export function exceedsJsonDepth(
  value: unknown,
  max: number = MAX_JSON_DEPTH,
): boolean {
  const stack: Array<{ item: unknown; depth: number }> = [
    { item: value, depth: 0 },
  ];
  for (let next = stack.pop(); next; next = stack.pop()) {
    const { item, depth } = next;
    if (typeof item !== 'object' || item === null) continue;
    if (depth >= max) return true;
    const children: unknown[] = Array.isArray(item)
      ? item
      : Object.values(item);
    for (const child of children) stack.push({ item: child, depth: depth + 1 });
  }
  return false;
}

/** Текст помилки для відповіді 400 (однаковий для всіх входів). */
export function jsonTooDeepMessage(what: string): string {
  return `${what}: вкладеність JSON глибша за ${MAX_JSON_DEPTH} рівні`;
}
