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
function invalid(): never {
  throw new Error('unsupported');
}
type Node = Record<string, unknown>;

function record(raw: unknown): Node {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid();
  return raw as Node;
}

export function compileProfile(source: string, contextBytes: number) {
  if (source.length > 4096) return invalid();
  const expression = jsonata(source, {
    timeout: 250,
    stack: 128,
    sequence: 4096,
  });
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
      projected += contextBytes;
      if (projected > 8 * 1024 * 1024) invalid();
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
  bytes: number,
): Promise<string> {
  let result: unknown;
  if (language === 'jsonata-v1')
    result = (await compileProfile(expr, bytes).evaluate(ctx)) as unknown;
  else {
    if (language !== undefined || !LEGACY_PATH.test(expr) || expr.length > 4096)
      invalid();
    let v: unknown = ctx;
    for (const field of expr.split('.').slice(1)) {
      if (v === null || v === undefined) invalid();
      v = Object.hasOwn(Object(v) as object, field)
        ? (v as Record<string, unknown>)[field]
        : undefined;
    }
    result = v ?? null;
  }
  if (result === undefined || exceedsJsonDepth(result, MAX_STEP_RESULT_DEPTH))
    invalid();
  const out = JSON.stringify(result, (_key, value: unknown) => {
    if (typeof value === 'number' && !Number.isFinite(value)) invalid();
    return value;
  });
  if (Buffer.byteLength(out) > RESULT_BYTES) invalid();
  return out;
}
