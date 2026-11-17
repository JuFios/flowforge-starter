import { validateDatabaseEnv } from '../../src/config/env.validation';
import {
  buildDataSourceOptions,
  QUERY_TIMEOUT_GRACE_MS,
} from '../../src/database/database.options';

describe('buildDataSourceOptions', () => {
  const db = validateDatabaseEnv({
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    DB_CONNECT_TIMEOUT_MS: '1500',
    DB_STATEMENT_TIMEOUT_MS: '2500',
  });

  it('bounds connecting, statements, idle transactions and the client wait', () => {
    expect(buildDataSourceOptions(db)).toMatchObject({
      connectTimeoutMS: 1500,
      extra: {
        statement_timeout: 2500,
        idle_in_transaction_session_timeout: 2500,
        query_timeout: 2500 + QUERY_TIMEOUT_GRACE_MS,
      },
    });
  });

  it('keeps the connect timeout but no statement limits for the migration CLI', () => {
    const options = buildDataSourceOptions(db, { statementTimeout: false });
    expect(options).toMatchObject({ connectTimeoutMS: 1500, extra: {} });
    expect(options.extra).not.toHaveProperty('statement_timeout');
  });
});
