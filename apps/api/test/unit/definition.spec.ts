import { BadRequestException } from '@nestjs/common';
import { validateSteps } from '../../src/workflows/definition';

describe('validateSteps', () => {
  it('accepts a valid definition', () => {
    const steps = validateSteps([
      { id: 'fetch', type: 'http', url: 'https://example.com' },
      { id: 'shape', type: 'transform', expr: 'ctx.steps.fetch.body' },
    ]);
    expect(steps).toHaveLength(2);
  });

  it('rejects an empty list', () => {
    expect(() => validateSteps([])).toThrow(BadRequestException);
  });

  it('rejects duplicate step ids', () => {
    expect(() =>
      validateSteps([
        { id: 'a', type: 'log', message: 'x' },
        { id: 'a', type: 'log', message: 'y' },
      ]),
    ).toThrow(BadRequestException);
  });

  it('rejects an unknown step type', () => {
    expect(() =>
      validateSteps([{ id: 'a', type: 'shell', cmd: 'ls' }]),
    ).toThrow(BadRequestException);
  });

  it('rejects a negative delay', () => {
    expect(() => validateSteps([{ id: 'a', type: 'delay', ms: -1 }])).toThrow(
      BadRequestException,
    );
  });

  const http = (extra: Record<string, unknown>) => [
    { id: 'call', type: 'http', url: 'https://example.com', ...extra },
  ];

  it.each([
    ['a non-string header value', http({ headers: { 'x-n': 1 } })],
    ['headers that are not an object', http({ headers: ['x'] })],
    [
      'an Idempotency-Key header set by the tenant',
      http({ headers: { 'Idempotency-Key': 'k' } }),
    ],
    [
      'too many headers',
      http({
        headers: Object.fromEntries(
          Array.from({ length: 51 }, (_, i) => [`x-${i}`, 'v']),
        ),
      }),
    ],
    ['an invalid header name', http({ headers: { 'bad header': 'v' } })],
    [
      'a header value with a line break',
      http({ headers: { 'x-a': 'v\r\nx-b: injected' } }),
    ],
    ['an unknown HTTP method', http({ method: 'TRACE' })],
    [
      'a non-http(s) url',
      [{ id: 'call', type: 'http', url: 'file:///etc/passwd' }],
    ],
    [
      'an overly long url',
      [
        {
          id: 'call',
          type: 'http',
          url: `https://example.com/${'a'.repeat(2048)}`,
        },
      ],
    ],
    [
      'an overly large body',
      http({ method: 'POST', body: 'x'.repeat(32 * 1024 + 1) }),
    ],
    ['a non-string body', http({ method: 'POST', body: { a: 1 } })],
    ['an unknown field', http({ timeoutMs: 1 })],
    [
      'an overly long transform expression',
      [{ id: 't', type: 'transform', expr: 'a'.repeat(4097) }],
    ],
    [
      'an overly long log message',
      [{ id: 'l', type: 'log', message: 'a'.repeat(4097) }],
    ],
    ['a fractional delay', [{ id: 'd', type: 'delay', ms: 1.5 }]],
    [
      'a delay longer than 30 days',
      [{ id: 'd', type: 'delay', ms: 30 * 24 * 3600 * 1000 + 1 }],
    ],
    [
      'more than 50 steps',
      Array.from({ length: 51 }, (_, i) => ({
        id: `s${i}`,
        type: 'log',
        message: 'x',
      })),
    ],
  ])('rejects %s', (_case, steps) => {
    expect(() => validateSteps(steps)).toThrow(BadRequestException);
  });

  it('accepts a long durable delay and well-formed http options', () => {
    expect(
      validateSteps([
        { id: 'wait', type: 'delay', ms: 7 * 24 * 3600 * 1000 },
        {
          id: 'call',
          type: 'http',
          method: 'post',
          url: 'http://example.com/hook',
          headers: { 'content-type': 'application/json', 'x-trace': 'a' },
          body: '{"a":1}',
        },
      ]),
    ).toHaveLength(2);
  });
});
