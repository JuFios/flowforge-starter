import { Resolver } from 'node:dns/promises';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { outboundHttp } from '../../src/engine/outbound-http';

describe('outbound HTTP socket and resource limits', () => {
  it.each(['timeout', 'overflow'] as const)(
    'closes the actual socket after %s and sends the next request',
    async (mode) => {
      let closed!: () => void;
      const finished = new Promise<void>((resolve) => {
        closed = resolve;
      });
      const server = createServer((req, res) => {
        if (req.url === '/good') return void res.end('ok');
        res.on('close', closed);
        res.writeHead(200);
        res.write(mode === 'overflow' ? 'x'.repeat(65) : 'x');
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const origin =
        'http://127.0.0.1:' + (server.address() as AddressInfo).port;
      Object.assign(process.env, {
        HTTP_FIXTURE_ORIGIN: origin,
        HTTP_FIXTURE_ADDRESS: '127.0.0.1',
        HTTP_RESPONSE_BYTES: '64',
        HTTP_STEP_TIMEOUT_MS: '250',
      });
      try {
        const call = (p: string) =>
          outboundHttp(new URL(p, origin), 'GET', new Headers(), undefined);
        await expect(call('/bad')).rejects.toThrow();
        await finished;
        await expect(call('/good')).resolves.toMatchObject({
          status: 200,
          body: 'ok',
        });
      } finally {
        for (const name of [
          'HTTP_FIXTURE_ORIGIN',
          'HTTP_FIXTURE_ADDRESS',
          'HTTP_RESPONSE_BYTES',
          'HTTP_STEP_TIMEOUT_MS',
        ])
          delete process.env[name];
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
      }
    },
  );
  it('uses the addresses returned to the connector and rechecks the next hop', async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(req.url!);
      res.writeHead(302, { location: '/next' }).end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = new URL(
      'http://receiver.invalid:' +
        (server.address() as AddressInfo).port +
        '/start',
    );
    process.env.HTTP_FIXTURE_ORIGIN = url.origin;
    process.env.HTTP_FIXTURE_ADDRESS = '127.0.0.1';
    const v4 = jest
      .spyOn(Resolver.prototype, 'resolve4')
      .mockImplementationOnce(() => Promise.resolve(['127.0.0.1']))
      .mockImplementation(() => Promise.resolve(['192.0.2.2']));
    jest
      .spyOn(Resolver.prototype, 'resolve6')
      .mockImplementation(() => Promise.resolve([]));
    try {
      await expect(
        outboundHttp(
          url,
          'GET',
          new Headers(),
          undefined,
          AbortSignal.timeout(2000),
        ),
      ).rejects.toThrow('destination is not allowed');
      expect(v4).toHaveBeenCalledTimes(2);
      expect(seen).toEqual(['/start']);
    } finally {
      jest.restoreAllMocks();
      delete process.env.HTTP_FIXTURE_ORIGIN;
      delete process.env.HTTP_FIXTURE_ADDRESS;
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
