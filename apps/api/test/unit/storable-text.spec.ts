import {
  findUnstorable,
  isStorableText,
  toStorable,
  toStorableText,
} from '../../src/common/storable-text';

const R = '�';

describe('text that Postgres can store', () => {
  it.each([
    ['plain text', 'hello'],
    ['a surrogate pair (emoji)', 'ok 😀'],
    ['other control characters', 'tab\tnew\nline\u0001'],
  ])('accepts %s', (_case, text) => {
    expect(isStorableText(text)).toBe(true);
    expect(toStorableText(text)).toBe(text);
  });

  it.each([
    ['U+0000', 'a\u0000b', `a${R}b`],
    ['a lone high surrogate', 'a\ud83db', `a${R}b`],
    ['a lone low surrogate', 'a\ude00b', `a${R}b`],
    ['a high surrogate at the end', 'a\ud83d', `a${R}`],
    ['two lone surrogates in reverse order', '\ude00\ud83d', `${R}${R}`],
  ])('replaces %s with U+FFFD', (_case, text, expected) => {
    expect(isStorableText(text)).toBe(false);
    expect(toStorableText(text)).toBe(expected);
    // Повторний виклик (глобальний RegExp зі станом lastIndex) дає той самий результат.
    expect(isStorableText(text)).toBe(false);
  });

  it('finds the path of the first unstorable key or value', () => {
    expect(findUnstorable({ a: [1, { b: 'ok' }] })).toBeUndefined();
    expect(findUnstorable({ a: [1, { b: 'x\u0000' }] })).toBe('$.a[1].b');
    expect(findUnstorable({ a: { ['k\u0000']: 1 } })).toBe(`$.a.k${R}`);
    expect(findUnstorable(['\ud800'], 'steps')).toBe('steps[0]');
    expect(findUnstorable(null)).toBeUndefined();
  });

  it('copies a JSON value with every unstorable character replaced, counting them', () => {
    const { value, replaced } = toStorable({
      ['k\u0000']: ['\ud800', { deep: 'a\u0000\u0000' }],
      n: 1,
      ok: true,
    });
    expect(value).toEqual({
      [`k${R}`]: [R, { deep: `a${R}${R}` }],
      n: 1,
      ok: true,
    });
    expect(replaced).toBe(4);
  });

  it('returns exactly what JSON stores for values JSON changes on the way', () => {
    expect(toStorable(undefined)).toEqual({ value: null, replaced: 0 });
    expect(
      toStorable({ at: new Date('2026-01-01T00:00:00Z'), gone: undefined })
        .value,
    ).toEqual({ at: '2026-01-01T00:00:00.000Z' });
  });
});
