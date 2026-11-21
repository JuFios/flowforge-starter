import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { buildPinoHttpOptions } from '../../src/observability/logger.options';
import { jsonLineSink } from '../helpers/json-log-sink';

/** Пропускає справжній HTTP-запит через pino-http з конфігурацією застосунку і читає, що потрапило в лог. */
describe('request logging', () => {
  let server: Server;
  let lines: Array<Record<string, unknown>>;
  let baseUrl: string;

  beforeAll(async () => {
    lines = [];
    const sink = jsonLineSink(lines);
    const options = buildPinoHttpOptions('info');
    const middleware = pinoHttp({ ...options, logger: pino(options, sink) });
    server = createServer((req, res) => {
      middleware(req, res);
      req.log.info(
        {
          tenant: { apiKey: 'ff_inner_secret', webhookSecret: 'whsec_inner' },
          err: {
            body: { nextSecret: 'deep_next_secret', secret: 'deep_secret' },
          },
        },
        'handler log',
      );
      res.setHeader('set-cookie', 'ff_api_key=cookie_secret');
      res.end('ok');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise((r) => server.close(r)));

  /** Кожен тест робить власний запит і дивиться лише на рядки свого запиту. */
  beforeEach(() => {
    lines.length = 0;
  });

  async function request(headers: Record<string, string>): Promise<void> {
    await fetch(`${baseUrl}/workflows`, { headers });
    // рядок «request completed» пишеться після завершення відповіді
    await new Promise((r) => setTimeout(r, 20));
  }

  it('redacts credentials and signatures from headers and nested fields', async () => {
    await request({
      'x-api-key': 'ff_header_secret',
      'x-admin-token': 'admin_header_secret',
      'x-signature': 'sig_header_secret',
      authorization: 'Bearer bearer_secret',
      cookie: 'ff_api_key=cookie_secret',
      'x-request-id': 'redact-1',
    });

    const output = JSON.stringify(lines);
    for (const secret of [
      'ff_header_secret',
      'admin_header_secret',
      'sig_header_secret',
      'bearer_secret',
      'cookie_secret',
      'ff_inner_secret',
      'whsec_inner',
      'deep_next_secret',
      'deep_secret',
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain('[REDACTED]');
  });

  it('tags request log lines with the correlation id', async () => {
    await request({ 'x-request-id': 'corr-tag-1' });

    const completed = lines.find((l) => l.msg === 'request completed');
    expect(completed).toMatchObject({ correlationId: 'corr-tag-1' });
    expect(lines.find((l) => l.msg === 'handler log')).toMatchObject({
      correlationId: 'corr-tag-1',
    });
  });
});
