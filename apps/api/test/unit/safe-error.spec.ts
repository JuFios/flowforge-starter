import { QueryFailedError } from 'typeorm';
import { toSafeError } from '../../src/observability/safe-error';

const SECRET = 'ff_live_9f2c1d7e-secret';

/** QueryFailedError так, як його будує TypeORM: повідомлення драйвера + код SQLSTATE. */
function queryFailed(message: string, code: string): QueryFailedError {
  const driverError = Object.assign(new Error(message), { code });
  return new QueryFailedError('SELECT $1::uuid', [SECRET], driverError);
}

describe('toSafeError with database errors', () => {
  it.each([
    ['invalid input syntax for type uuid: "%s"', '22P02', 'invalid input syntax for type uuid'],
    ['invalid input value for enum job_status: "%s"', '22P02', 'invalid input value for enum job_status'],
    ['value "%s" is out of range for type integer', '22003', 'is out of range for type integer'],
    ['date/time field value out of range: "%s"', '22008', 'date/time field value out of range'],
    ['malformed array literal: "%s"', '22P02', 'malformed array literal'],
    ['syntax error at or near "%s"', '42601', 'syntax error at or near'],
    ['invalid input syntax for type uuid: "a"b\nc %s"', '22P02', 'invalid input syntax for type uuid'],
  ])('masks the input value in "%s" and keeps the gist and SQLSTATE', (template, code, gist) => {
    const safe = toSafeError(queryFailed(template.replace('%s', SECRET), code));

    expect(JSON.stringify(safe)).not.toContain(SECRET);
    expect(safe.message).toContain(gist);
    expect(safe).toMatchObject({ type: 'QueryFailedError', code });
  });

  it('keeps identifiers (relation, column, constraint) that carry no input', () => {
    const message = 'null value in column "apiKeyHash" of relation "tenants" violates not-null constraint';
    expect(toSafeError(queryFailed(message, '23502')).message).toBe(message);
  });
});
