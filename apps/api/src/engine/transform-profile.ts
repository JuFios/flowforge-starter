import jsonata from 'jsonata';
import { MAX_STEP_RESULT_DEPTH, exceedsJsonDepth } from '../common/json-depth';
import type { StepContext } from './template';

export const CONTEXT_BYTES = 4 * 1024 * 1024;
export const RESULT_BYTES = 65536;
export const LEGACY_PATH =
  /^ctx\.(input|steps)(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;
const SPECIAL = new Set(['__proto__', 'prototype', 'constructor']);
const OPS = new Set([
  '+',
  '-',
  '*',
  '/',
  '%',
  '=',
  '!=',
  '<',
  '>',
  '<=',
  '>=',
  'and',
  'or',
]);
/** Вираз або його результат поза профілем чи межами ресурсів (README 3.3.6). */
export class TransformLimitError extends Error {
  constructor() {
    super('unsupported');
  }
}
/** Вираз у профілі, але обчислення над цими даними не вдалося (напр., арифметика над рядком). */
export class TransformEvaluationError extends Error {
  constructor() {
    super('evaluation failed');
  }
}
/** Коди виходу дочірнього процесу обчислення (isolated-transform.ts). */
export const EXIT_LIMIT = 3;
export const EXIT_EVALUATION = 4;
/** Коди JSONata для перевищення меж послідовності, стеку й часу. */
const LIMIT_CODES = new Set(['D1011', 'D1012', 'D2015']);
/** Верхня оцінка проміжних значень для всіх посилань виразу на контекст. */
export const PROJECTED_BYTES = 8 * 1024 * 1024;

function invalid(): never {
  throw new TransformLimitError();
}

/**
 * Скільки байтів JSON щонайбільше читає шлях з іменованих кроків: значення за найглибшим
 * власним префіксом. На масиві шлях JSONata розходиться по елементах, тож межею є весь масив.
 */
function referencedBytes(
  ctx: StepContext,
  names: string[],
  cache: Map<string, number>,
): number {
  const key = names.join('.');
  const known = cache.get(key);
  if (known !== undefined) return known;
  let value: unknown = ctx;
  for (const name of names) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      break;
    if (!Object.hasOwn(value, name)) {
      value = undefined;
      break;
    }
    value = (value as Record<string, unknown>)[name];
  }
  const bytes =
    value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value) ?? '');
  cache.set(key, bytes);
  return bytes;
}
type Node = Record<string, unknown>;

function record(raw: unknown): Node {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid();
  return raw as Node;
}

/**
 * Компілює вираз і перевіряє AST за закритим профілем. З контекстом виконання (воркер) додатково
 * оцінює обсяг даних, які читають шляхи виразу; під час валідації визначення контексту немає.
 */
export function compileProfile(source: string, ctx?: StepContext) {
  if (source.length > 4096) return invalid();
  let expression: ReturnType<typeof jsonata>;
  try {
    expression = jsonata(source, {
      timeout: 250,
      stack: 128,
      sequence: 4096,
    });
  } catch {
    return invalid();
  }
  const sizes = new Map<string, number>();
  // Перелік полів закритий: модифікатори шляху й нові типи вузлів потребують окремого рішення.
  let count = 0,
    projected = 0;
  function inspect(raw: unknown, depth: number): void {
    if (++count > 256 || depth > 32) invalid();
    const n = record(raw);
    const fields = (...keys: string[]) => {
      if (
        Object.keys(n).some(
          (k) => !['type', 'position', 'value', ...keys].includes(k),
        )
      )
        invalid();
    };
    const child = (v: unknown) => inspect(v, depth + 1);
    if (n.type === 'path') {
      fields('steps');
      if (!Array.isArray(n.steps) || !n.steps.length || n.steps.length > 32)
        invalid();
      for (const [i, v] of n.steps.entries()) {
        const step = record(v);
        if (
          ++count > 256 ||
          step.type !== 'name' ||
          typeof step.value !== 'string' ||
          SPECIAL.has(step.value) ||
          (i === 0 && !['input', 'steps'].includes(step.value)) ||
          Object.keys(step).some(
            (k) => !['type', 'position', 'value'].includes(k),
          )
        )
          invalid();
      }
      if (ctx) {
        projected += referencedBytes(
          ctx,
          n.steps.map((v) => (v as Node).value as string),
          sizes,
        );
        if (projected > PROJECTED_BYTES) invalid();
      }
    } else if (['value', 'string', 'number'].includes(String(n.type))) fields();
    else if (
      n.type === 'binary' &&
      typeof n.value === 'string' &&
      OPS.has(n.value)
    ) {
      fields('lhs', 'rhs');
      child(n.lhs);
      child(n.rhs);
    } else if (n.type === 'condition') {
      fields('condition', 'then', 'else');
      child(n.condition);
      child(n.then);
      if (n.else !== undefined) child(n.else);
    } else if (n.type === 'unary' && n.value === '-') {
      fields('expression');
      child(n.expression);
    } else if ((n.type === 'unary' && n.value === '[') || n.type === 'block') {
      fields('expressions');
      if (
        !Array.isArray(n.expressions) ||
        (n.type === 'block' && n.expressions.length !== 1)
      )
        invalid();
      n.expressions.forEach(child);
    } else if (n.type === 'unary' && n.value === '{') {
      fields('lhs');
      if (!Array.isArray(n.lhs)) invalid();
      for (const pair of n.lhs) {
        if (!Array.isArray(pair) || pair.length !== 2) invalid();
        const key = record(pair[0]);
        if (
          key.type !== 'string' ||
          typeof key.value !== 'string' ||
          SPECIAL.has(key.value)
        )
          invalid();
        child(key);
        child(pair[1]);
      }
    } else invalid();
  }
  inspect(expression.ast(), 0);
  return expression;
}

export async function evaluateTransform(
  expr: string,
  language: unknown,
  ctx: StepContext,
): Promise<string> {
  let result: unknown;
  if (language === 'jsonata-v1') {
    const expression = compileProfile(expr, ctx);
    try {
      result = (await expression.evaluate(ctx)) as unknown;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === 'string' && LIMIT_CODES.has(code)) invalid();
      throw new TransformEvaluationError();
    }
  } else {
    if (language !== undefined || !LEGACY_PATH.test(expr) || expr.length > 4096)
      invalid();
    let v: unknown = ctx;
    for (const field of expr.split('.').slice(1)) {
      // Як у старому JS-виразі: читання властивості відсутнього проміжного значення — помилка.
      if (v === null || v === undefined) throw new TransformEvaluationError();
      v = Object.hasOwn(Object(v) as object, field)
        ? (v as Record<string, unknown>)[field]
        : undefined;
    }
    result = v;
  }
  // Шлях без значення (у JSONata — відсутній збіг) дає null, однаково для обох мов.
  if (result === undefined) result = null;
  if (exceedsJsonDepth(result, MAX_STEP_RESULT_DEPTH)) invalid();
  const out = JSON.stringify(result, (_key, value: unknown) => {
    if (typeof value === 'number' && !Number.isFinite(value)) invalid();
    return value;
  });
  if (Buffer.byteLength(out) > RESULT_BYTES) invalid();
  return out;
}
