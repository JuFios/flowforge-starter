import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { buildPinoHttpOptions } from '../../src/observability/logger.options';

/** Пропускає справжній HTTP-запит через pino-http з конфігурацією застосунку і читає, що потрапило в лог. */
describe('request logging', () => {
  let server: Server;
  let lines: Array<Record<string, unknown>>;
  let baseUrl: string;

  beforeAll(async () => {
    lines = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        for (const line of chunk.toString().split('\n').filter(Boolean)) lines.push(JSON.parse(line));
        cb();
      },
    });
    const options = buildPinoHttpOptions('info');
    const middleware = pinoHttp({ ...options, logger: pino(options, sink) });
    server = createServer((req, res) => {
      middleware(req, res);
      req.log.info({ tenant: { apiKey: 'ff_inner_secret', webhookSecret: 'whsec_inner' } }, 'handler log');
      res.setHeader('set-cookie', 'ff_api_key=cookie_secret');
      res.end('ok');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise((r) => server.close(r)));

  it('redacts credentials and signatures from headers and nested fields', async () => {
    await fetch(`${baseUrl}/workflows`, {
      headers: {
        'x-api-key': 'ff_header_secret',
        'x-admin-token': 'admin_header_secret',
        'x-signature': 'sig_header_secret',
        authorization: 'Bearer bearer_secret',
        cookie: 'ff_api_key=cookie_secret',
        'x-request-id': 'redact-1',
      },
    });
    await new Promise((r) => setTimeout(r, 20));

    const output = JSON.stringify(lines);
    for (const secret of [
      'ff_header_secret',
      'admin_header_secret',
      'sig_header_secret',
      'bearer_secret',
      'cookie_secret',
      'ff_inner_secret',
      'whsec_inner',
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain('[REDACTED]');
  });

  it('tags request log lines with the correlation id', () => {
    const completed = lines.find((l) => l.msg === 'request completed');
    expect(completed).toMatchObject({ correlationId: 'redact-1' });
    expect(lines.find((l) => l.msg === 'handler log')).toMatchObject({ correlationId: 'redact-1' });
  });
});
