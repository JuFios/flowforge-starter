import { BadRequestException } from '@nestjs/common';
import {
  exceedsJsonDepth,
  MAX_JSON_DEPTH,
  MAX_STEP_RESULT_DEPTH,
} from '../../src/common/json-depth';
import { parseRunInput } from '../../src/executions/run-input.pipe';
import { validateSteps } from '../../src/workflows/definition';

/** Об'єкт із `depth` рівнями вкладеності (`{a:{a:…}}`), побудований без рекурсії. */
function nested(depth: number, leaf: unknown = 1): unknown {
  let value = leaf;
  for (let i = 0; i < depth; i++) value = { a: value };
  return value;
}

describe('JSON nesting depth', () => {
  it.each([
    ['a primitive', 'x', 0],
    ['an empty object', {}, 1],
    ['an empty array', [], 1],
    ['an object inside an array', [{ a: 1 }], 2],
  ])('counts %s as %i levels', (_case, value, depth) => {
    expect(exceedsJsonDepth(value, depth)).toBe(false);
    if (depth > 0) expect(exceedsJsonDepth(value, depth - 1)).toBe(true);
  });

  it('finds the deepest branch, not only the first one', () => {
    expect(exceedsJsonDepth({ a: 1, b: [[[]]] }, 3)).toBe(true);
    expect(exceedsJsonDepth({ a: 1, b: [[[]]] }, 4)).toBe(false);
  });

  it(`accepts ${MAX_JSON_DEPTH} levels by default and rejects one more`, () => {
    expect(exceedsJsonDepth(nested(MAX_JSON_DEPTH))).toBe(false);
    expect(exceedsJsonDepth(nested(MAX_JSON_DEPTH + 1))).toBe(true);
  });

  it('keeps the step result limit far below the depth JSON.stringify can serialize', () => {
    // Чекпоінт і шаблони серіалізують результат: на межі запас стека має лишатися.
    expect(() =>
      JSON.stringify(nested(MAX_STEP_RESULT_DEPTH * 2)),
    ).not.toThrow();
  });

  it('measures a value nested deeper than the call stack allows without throwing', () => {
    expect(exceedsJsonDepth(nested(100_000))).toBe(true);
  });

  it('rejects run input nested too deep with a 400 explanation, before serializing it', () => {
    const input = nested(100_000);
    expect(() => parseRunInput(input)).toThrow(BadRequestException);
    expect(() => parseRunInput(input)).toThrow(/64/);
    expect(parseRunInput(nested(MAX_JSON_DEPTH))).toEqual(
      nested(MAX_JSON_DEPTH),
    );
  });

  it('rejects step definitions nested too deep with a 400 explanation', () => {
    const steps = [
      { id: 's', type: 'log', message: 'm', extra: nested(100_000) },
    ];
    expect(() => validateSteps(steps)).toThrow(BadRequestException);
    expect(() => validateSteps(steps)).toThrow(/64/);
  });
});
