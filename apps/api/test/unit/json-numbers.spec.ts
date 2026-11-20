import {
  findInexactNumber,
  isExactJsonNumber,
} from '../../src/common/json-numbers';

/** Числа JSON, які `JSON.parse` + `JSON.stringify` змінили б до збереження. */
describe('exact JSON numbers', () => {
  it.each([
    '0',
    '-0',
    '1',
    '-1',
    '1.0',
    '1.50',
    '0.1',
    '0.30000000000000004',
    '1e2',
    '1E+2',
    '100e-2',
    '1e21',
    '1.7976931348623157e308',
    '5e-324',
    '9007199254740991',
    '9007199254740992',
    '-9007199254740992',
    '123456789012345680000',
  ])('keeps %s', (token) => {
    expect(isExactJsonNumber(token)).toBe(true);
  });

  it.each([
    ['1e400', 'overflows to Infinity'],
    ['-1e400', 'overflows to -Infinity'],
    ['1e-400', 'underflows to 0'],
    ['12345678901234567890', 'loses integer digits'],
    ['9007199254740993', 'is MAX_SAFE_INTEGER + 2, not representable'],
    ['1.00000000000000000001', 'loses fraction digits'],
    ['0.1000000000000000000001', 'loses fraction digits'],
    ['1e99999999999999999999', 'has a huge exponent'],
  ])('rejects %s (%s)', (token) => {
    expect(isExactJsonNumber(token)).toBe(false);
  });

  it('agrees with a round trip through JSON for many generated numbers', () => {
    // Детермінований генератор: межі експонент і довжини мантиси навколо 17 значущих цифр.
    let seed = 7;
    const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (let n = 0; n < 5_000; n++) {
      const digits = String(Math.floor(rnd() * 1e17)).padStart(
        1 + Math.floor(rnd() * 22),
        '7',
      );
      const exp = Math.floor(rnd() * 700) - 350;
      const token = `${rnd() < 0.5 ? '-' : ''}${digits[0]}.${digits.slice(1) || '0'}e${exp}`;
      const stored = JSON.stringify(JSON.parse(token));
      const exact = BigIntDecimal.equal(token, stored);
      expect({ token, exact: isExactJsonNumber(token) }).toEqual({
        token,
        exact,
      });
    }
  });
});

describe('findInexactNumber', () => {
  it.each([
    ['{"amount":1e400}', '$.amount'],
    ['{"a":[1,2,{"b":12345678901234567890}]}', '$.a[2].b'],
    ['[0,1,-1e400]', '$[2]'],
    ['{"x":{"y":1},"z":1e-400}', '$.z'],
    // Ключ із лапкою, крапкою, дужкою чи U+0000 — у вигляді ["…"], щоб шлях був однозначним.
    ['{"k\\"ey":1e400}', '$["k\\"ey"]'],
    ['{"a.b":{"c":1e400}}', '$["a.b"].c'],
    ['{"x[0]":1e400}', '$["x[0]"]'],
    ['{"a\\u0000":1e400}', '$["a�"]'],
    ['1e400', '$'],
  ])('finds the inexact number in %s', (text, path) => {
    expect(findInexactNumber(text)).toBe(path);
  });

  it.each([
    '{"amount":12.5,"n":-0,"big":9007199254740991}',
    // Числа всередині рядків і ключів — це текст, а не числа.
    '{"note":"1e400 and 12345678901234567890","1e400":"x"}',
    '{"esc":"\\"1e400\\\\","t":true,"f":false,"z":null}',
    '{}',
    '[]',
    '',
  ])('accepts %s', (text) => {
    expect(findInexactNumber(text)).toBeUndefined();
  });

  it('does not throw on invalid JSON (the parser reports it)', () => {
    for (const text of [
      '{"a":',
      '{"a":1e',
      '{"\\x":1}',
      '}}]]',
      '"open',
      '{a}',
    ])
      expect(() => findInexactNumber(text)).not.toThrow();
  });

  it('scans deep nesting and a 1 MiB body without recursion', () => {
    const deep = '['.repeat(200_000) + '1e400' + ']'.repeat(200_000);
    // Шлях обрізано: глибину й ключі задає клієнт, а шлях іде у відповідь.
    expect(findInexactNumber(deep)).toBe(
      ('$' + '[0]'.repeat(100)).slice(0, 200) + '…',
    );
    const big = `{"rows":[${Array.from({ length: 80_000 }, (_, i) => i).join(',')},1e400]}`;
    expect(big.length).toBeGreaterThan(400_000);
    const started = Date.now();
    expect(findInexactNumber(big)).toBe('$.rows[80000]');
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('scanner cost on hostile single tokens', () => {
  // Сканер працює до автентифікації: жоден токен у тілі 1 МіБ не може коштувати більше за
  // лінійний прохід. Колишнє `/0+$/` на 100 000 нулях посередині числа займало 14 с.
  const n = 1_000_000;
  it.each([
    ['zeros inside an integer', '1' + '0'.repeat(n) + '1'],
    ['zeros inside a fraction', '0.' + '0'.repeat(n) + '1'],
    ['trailing zeros of a fraction', '1.' + '0'.repeat(n)],
    ['a long exponent', '1e' + '0'.repeat(n) + '1'],
    ['a long mantissa', '-' + '9'.repeat(n)],
    ['zeros before an exponent', '1' + '0'.repeat(n) + 'e-' + String(n)],
  ])('%s stays linear', (_case, token) => {
    const text = `{"a":${token}}`;
    const started = Date.now();
    findInexactNumber(text);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

/** Еталон: точне порівняння двох десяткових записів через BigInt (незалежно від сканера). */
const BigIntDecimal = {
  parse(token: string): { sign: bigint; mantissa: bigint; exp: number } {
    const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
    if (!m) throw new Error(`not a number: ${token}`);
    const fraction = m[3] ?? '';
    return {
      sign: m[1] ? -1n : 1n,
      mantissa: BigInt(m[2] + fraction),
      exp: Number(m[4] ?? 0) - fraction.length,
    };
  },
  equal(a: string, b: string): boolean {
    if (b === 'null') return false;
    const x = this.parse(a);
    const y = this.parse(b);
    if (x.mantissa === 0n || y.mantissa === 0n)
      return x.mantissa === y.mantissa;
    const shift = Math.min(x.exp, y.exp);
    const xs = x.sign * x.mantissa * 10n ** BigInt(x.exp - shift);
    const ys = y.sign * y.mantissa * 10n ** BigInt(y.exp - shift);
    return xs === ys;
  },
};
