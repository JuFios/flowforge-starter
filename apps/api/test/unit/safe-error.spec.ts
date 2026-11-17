import { QueryFailedError } from 'typeorm';
import {
  MAX_DB_MESSAGE_LENGTH,
  toSafeError,
} from '../../src/observability/safe-error';

const SECRET = 'ff_live_9f2c1d7e-secret';

/** QueryFailedError так, як його будує TypeORM: повідомлення драйвера + код SQLSTATE. */
function queryFailed(message: string, code: string): QueryFailedError {
  const driverError = Object.assign(new Error(message), { code });
  return new QueryFailedError('SELECT $1::uuid', [SECRET], driverError);
}

describe('toSafeError with database errors', () => {
  it.each([
    [
      'invalid input syntax for type uuid: "%s"',
      '22P02',
      'invalid input syntax for type uuid',
    ],
    [
      'invalid input value for enum job_status: "%s"',
      '22P02',
      'invalid input value for enum job_status',
    ],
    [
      'value "%s" is out of range for type integer',
      '22003',
      'is out of range for type integer',
    ],
    [
      'date/time field value out of range: "%s"',
      '22008',
      'date/time field value out of range',
    ],
    ['malformed array literal: "%s"', '22P02', 'malformed array literal'],
    ['syntax error at or near "%s"', '42601', 'syntax error at or near'],
    [
      'invalid input syntax for type uuid: "a"b\nc %s"',
      '22P02',
      'invalid input syntax for type uuid',
    ],
  ])(
    'masks the input value in "%s" and keeps the gist and SQLSTATE',
    (template, code, gist) => {
      const safe = toSafeError(
        queryFailed(template.replace('%s', SECRET), code),
      );

      expect(JSON.stringify(safe)).not.toContain(SECRET);
      expect(safe.message).toContain(gist);
      expect(safe).toMatchObject({ type: 'QueryFailedError', code });
    },
  );

  it('keeps identifiers (relation, column, constraint) that carry no input', () => {
    const message =
      'null value in column "apiKeyHash" of relation "tenants" violates not-null constraint';
    expect(toSafeError(queryFailed(message, '23502')).message).toBe(message);
  });

  it('masks the value in the first line of the stack too', () => {
    const safe = toSafeError(
      queryFailed(`invalid input syntax for type uuid: "${SECRET}"`, '22P02'),
    );
    expect(safe.stack).toMatch(
      /^QueryFailedError: invalid input syntax for type uuid: "\[redacted\]"\n\s+at /,
    );
  });

  it('masks byte sequences and caps very long driver messages', () => {
    expect(
      toSafeError(
        queryFailed(
          'invalid byte sequence for encoding "UTF8": 0xd0 0x3c',
          '22021',
        ),
      ).message,
    ).toBe('invalid byte sequence for encoding "UTF8": [redacted]');
    const long = toSafeError(
      queryFailed(`could not do something with ${'x'.repeat(1000)}`, 'XX000'),
    ).message;
    expect(long.length).toBeLessThanOrEqual(MAX_DB_MESSAGE_LENGTH + 1);
  });

  it('recognises raw driver errors by their SQLSTATE and leaves other errors as they are', () => {
    const raw = Object.assign(
      new Error(`invalid input syntax for type uuid: "${SECRET}"`),
      { code: '22P02' },
    );
    expect(toSafeError(raw).message).not.toContain(SECRET);
    const node = Object.assign(new Error('write EPIPE: "pipe"'), {
      code: 'EPIPE',
    });
    expect(toSafeError(node).message).toBe('write EPIPE: "pipe"');
  });
});

describe('toSafeError with JSON parse errors', () => {
  it('drops the fragment of the input that V8 repeats in the message and stack', () => {
    let parseError: Error | undefined;
    try {
      JSON.parse('{"headers":{"Authorization": Sk9xQ2vLp7Rm}}');
    } catch (err) {
      parseError = err as Error;
    }
    const safe = toSafeError(parseError);
    expect(JSON.stringify(safe)).not.toContain('Sk9xQ2');
    expect(safe.message).toBe(
      `Unexpected token 'S', "[redacted]" is not valid JSON`,
    );
    expect(safe.stack).toMatch(
      /^SyntaxError: Unexpected token 'S', "\[redacted\]" is not valid JSON\n/,
    );
  });

  it('leaves JSON errors without a fragment unchanged', () => {
    expect(
      toSafeError(new SyntaxError('Unexpected end of JSON input')).message,
    ).toBe('Unexpected end of JSON input');
  });
});
