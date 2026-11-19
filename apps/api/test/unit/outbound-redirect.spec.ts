import { Response } from 'undici';
import {
  outboundHttp,
  outboundTransport,
} from '../../src/engine/outbound-http';

/**
 * Контракт ручних редиректів (README 3.3.6): кожен перехід проходить політику адрес до відправлення,
 * метод і тіло змінюються за правилами Fetch, на інший origin не переходять тіло, ефект і
 * заголовки тенанта, HTTPS→HTTP заборонено, переходів не більше п'яти.
 */
interface Hop {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function transport(...responses: Response[]) {
  const hops: Hop[] = [];
  const spy = jest
    .spyOn(outboundTransport, 'fetch')
    .mockImplementation((url, init) => {
      hops.push({
        url: String(url),
        method: String(init?.method),
        headers: Object.fromEntries(init?.headers as [string, string][]),
        body: init?.body,
      });
      const next = responses.shift();
      if (!next) throw new Error('unexpected request');
      return Promise.resolve(next);
    });
  return { hops, spy };
}

const redirect = (status: number, location: string) =>
  new Response(null, { status, headers: { location } });
const ok = () => new Response('{"ok":true}', { status: 200 });

const tenantHeaders = () =>
  new Headers({
    authorization: 'Bearer tenant-token',
    'content-type': 'application/json',
    'idempotency-key': 'step-key',
    'x-custom': 'tenant-value',
  });

describe('outbound HTTP redirects', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([
    [301, 'POST', 'GET', undefined],
    [302, 'POST', 'GET', undefined],
    [303, 'POST', 'GET', undefined],
    [303, 'PUT', 'GET', undefined],
    [301, 'PUT', 'PUT', '{"a":1}'],
    [307, 'POST', 'POST', '{"a":1}'],
    [308, 'POST', 'POST', '{"a":1}'],
  ])(
    'follows %i for %s on the same origin as %s with body %s',
    async (status, method, nextMethod, nextBody) => {
      const { hops } = transport(redirect(status, '/next'), ok());
      await expect(
        outboundHttp(
          new URL('https://receiver.example/start'),
          method,
          tenantHeaders(),
          '{"a":1}',
        ),
      ).resolves.toMatchObject({ status: 200, body: '{"ok":true}' });
      expect(hops.map((h) => h.url)).toEqual([
        'https://receiver.example/start',
        'https://receiver.example/next',
      ]);
      expect(hops[1].method).toBe(nextMethod);
      expect(hops[1].body).toBe(nextBody);
      // Той самий origin: ключ ідемпотентності й заголовки тенанта зберігаються.
      expect(hops[1].headers).toMatchObject({
        authorization: 'Bearer tenant-token',
        'idempotency-key': 'step-key',
        'x-custom': 'tenant-value',
      });
      if (nextBody === undefined)
        expect(hops[1].headers['content-type']).toBeUndefined();
    },
  );

  it('drops every tenant header when a GET moves to another origin', async () => {
    const { hops } = transport(
      redirect(302, 'https://other.example/landing'),
      ok(),
    );
    await outboundHttp(
      new URL('https://receiver.example/start'),
      'GET',
      tenantHeaders(),
      undefined,
    );
    expect(hops[1].url).toBe('https://other.example/landing');
    expect(hops[1].method).toBe('GET');
    expect(hops[1].headers).toEqual({ 'accept-encoding': 'identity' });
  });

  it('moves a POST to another origin only after 303 turns it into a body-less GET', async () => {
    const { hops } = transport(redirect(303, 'https://other.example/'), ok());
    await outboundHttp(
      new URL('https://receiver.example/start'),
      'POST',
      tenantHeaders(),
      '{"a":1}',
    );
    expect(hops[1]).toMatchObject({ method: 'GET', body: undefined });
    expect(hops[1].headers).toEqual({ 'accept-encoding': 'identity' });
  });

  it.each([307, 308])(
    'refuses to carry a POST body to another origin on %i',
    async (status) => {
      const { spy } = transport(redirect(status, 'https://other.example/'));
      await expect(
        outboundHttp(
          new URL('https://receiver.example/start'),
          'POST',
          tenantHeaders(),
          '{"a":1}',
        ),
      ).rejects.toMatchObject({
        message: 'http destination is not allowed',
        retryable: false,
      });
      expect(spy).toHaveBeenCalledTimes(1);
    },
  );

  it('refuses a downgrade from HTTPS to HTTP', async () => {
    const { spy } = transport(redirect(302, 'http://receiver.example/plain'));
    await expect(
      outboundHttp(
        new URL('https://receiver.example/start'),
        'GET',
        new Headers(),
        undefined,
      ),
    ).rejects.toMatchObject({ retryable: false });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1:8080/',
    'http://10.0.0.5/',
    'http://[::1]/',
    'http://[::ffff:7f00:1]/',
    'http://2130706433/',
    'http://0x7f.1/',
    'http://[fd00:ec2::254]/',
    'http://100.100.100.200/',
  ])(
    'rejects a redirect to the internal address %s before sending it',
    async (location) => {
      const { spy } = transport(redirect(302, location));
      await expect(
        outboundHttp(
          new URL('http://receiver.example/start'),
          'GET',
          new Headers(),
          undefined,
        ),
      ).rejects.toMatchObject({
        message: 'http destination is not allowed',
        retryable: false,
      });
      expect(spy).toHaveBeenCalledTimes(1);
    },
  );

  it('follows five redirects and refuses the sixth', async () => {
    const chain = (n: number) =>
      Array.from({ length: n }, (_, i) => redirect(302, `/hop-${i + 1}`));
    const followed = transport(...chain(5), ok());
    await expect(
      outboundHttp(
        new URL('https://receiver.example/start'),
        'GET',
        new Headers(),
        undefined,
      ),
    ).resolves.toMatchObject({ status: 200 });
    expect(followed.spy).toHaveBeenCalledTimes(6);
    jest.restoreAllMocks();

    const refused = transport(...chain(6));
    await expect(
      outboundHttp(
        new URL('https://receiver.example/start'),
        'GET',
        new Headers(),
        undefined,
      ),
    ).rejects.toMatchObject({
      message: 'http redirect is invalid or exceeds the limit',
      retryable: false,
    });
    expect(refused.spy).toHaveBeenCalledTimes(6);
  });

  it('rejects a Location that is not a URL', async () => {
    const { spy } = transport(redirect(302, 'http://['));
    await expect(
      outboundHttp(
        new URL('https://receiver.example/start'),
        'GET',
        new Headers(),
        undefined,
      ),
    ).rejects.toMatchObject({ retryable: false });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
