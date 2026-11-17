import {
  ArgumentsHost,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { QueryFailedError } from 'typeorm';
import { AllExceptionsFilter } from '../../src/observability/all-exceptions.filter';

const SECRET = 'Bearer tenant-secret-token';

/** Розгортає й Error-об'єкти з усіма власними полями, щоб побачити все, що отримав логер. */
function dump(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v instanceof Error
      ? Object.fromEntries(
          Object.getOwnPropertyNames(v).map((k) => [k, (v as never)[k]]),
        )
      : v,
  );
}

function setup(headers: Record<string, string> = {}) {
  const request = { headers };
  const response = {};
  const adapter = { reply: jest.fn(), setHeader: jest.fn() };
  const filter = new AllExceptionsFilter({
    httpAdapter: adapter,
  } as unknown as HttpAdapterHost);
  const host = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
  return { filter, host, adapter, response };
}

function queryFailed(): QueryFailedError {
  const driverError = Object.assign(
    new Error('duplicate key value violates unique constraint "UQ_x"'),
    {
      code: '23505',
      detail: `Key (steps)=({"headers":{"Authorization":"${SECRET}"}}) already exists.`,
    },
  );
  return new QueryFailedError(
    'INSERT INTO "workflows"("steps") VALUES ($1)',
    [
      JSON.stringify([
        { id: 'call', type: 'http', headers: { Authorization: SECRET } },
      ]),
    ],
    driverError,
  );
}

describe('AllExceptionsFilter', () => {
  let logged: jest.SpyInstance;

  beforeEach(() => {
    logged = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('logs a database error without its query parameters or driver details', () => {
    const { filter, host } = setup();
    filter.catch(queryFailed(), host);

    expect(logged).toHaveBeenCalledTimes(1);
    const output = dump(logged.mock.calls);
    expect(output).not.toContain('tenant-secret-token');
    expect(output).not.toContain('INSERT INTO');
    expect(output).toContain('QueryFailedError');
    expect(output).toContain('23505');
    expect(output).toMatch(/at .+all-exceptions\.filter\.spec\.ts/);
  });

  it('logs a 5xx HttpException without the attached cause', () => {
    const { filter, host } = setup();
    filter.catch(
      new InternalServerErrorException('upstream failed', {
        cause: queryFailed(),
      }),
      host,
    );

    expect(dump(logged.mock.calls)).not.toContain('tenant-secret-token');
  });

  it('answers with a generic message and sets x-request-id to the same correlation id', () => {
    const { filter, host, adapter, response } = setup();
    filter.catch(queryFailed(), host);

    const [res, body, status] = adapter.reply.mock.calls[0];
    expect(res).toBe(response);
    expect(status).toBe(500);
    expect(body).toEqual({
      statusCode: 500,
      message: 'Internal server error',
      correlationId: expect.any(String),
    });
    expect(adapter.setHeader).toHaveBeenCalledWith(
      response,
      'x-request-id',
      body.correlationId,
    );
  });

  it('reuses a valid incoming x-request-id', () => {
    const { filter, host, adapter, response } = setup({
      'x-request-id': 'incoming-1',
    });
    filter.catch(new Error('boom'), host);

    expect(adapter.reply.mock.calls[0][1]).toMatchObject({
      correlationId: 'incoming-1',
    });
    expect(adapter.setHeader).toHaveBeenCalledWith(
      response,
      'x-request-id',
      'incoming-1',
    );
  });

  it('maps http-errors with a 4xx status to that status and a standard message', () => {
    const { filter, host, adapter } = setup();
    const tooLarge = Object.assign(
      new Error('request entity too large: limit 102400'),
      { status: 413, type: 'entity.too.large' },
    );
    filter.catch(tooLarge, host);

    const [, body, status] = adapter.reply.mock.calls[0];
    expect(status).toBe(413);
    expect(body).toEqual({
      statusCode: 413,
      message: 'Payload Too Large',
      correlationId: expect.any(String),
    });
  });

  it('does not trust a non-4xx status carried by an arbitrary error', () => {
    const { filter, host, adapter } = setup();
    filter.catch(
      Object.assign(new Error('upstream exploded at 10.0.0.5'), {
        status: 502,
      }),
      host,
    );

    const [, body, status] = adapter.reply.mock.calls[0];
    expect(status).toBe(500);
    expect(body).toEqual({
      statusCode: 500,
      message: 'Internal server error',
      correlationId: expect.any(String),
    });
  });

  it('puts the correlation id returned to the client into the log record', () => {
    const { filter, host, adapter } = setup({ 'x-request-id': 'early-1' });
    filter.catch(
      Object.assign(new Error('unsupported charset "KOI8-R"'), { status: 415 }),
      host,
    );

    expect(adapter.reply.mock.calls[0][1]).toMatchObject({
      correlationId: 'early-1',
    });
    const warned = jest.mocked(Logger.prototype.warn).mock.calls[0][0];
    expect(warned).toMatchObject({
      correlationId: 'early-1',
      status: 415,
      error: { type: 'Error' },
    });
  });
});
