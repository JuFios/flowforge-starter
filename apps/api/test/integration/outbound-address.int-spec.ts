import { Resolver } from 'node:dns/promises';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { outboundHttp } from '../../src/engine/outbound-http';

describe('outbound HTTP socket and resource limits', () => {
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
