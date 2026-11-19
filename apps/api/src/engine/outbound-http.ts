import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import ipaddr from 'ipaddr.js';
import {
  Agent,
  buildConnector,
  fetch as send,
  type Response,
  type RequestInit,
} from 'undici';

export const outboundTransport = { fetch: send };
import { StepError } from './step-error';
import { MAX_URL_LENGTH } from '../workflows/definition';
import { getCorrelationId } from '../observability/correlation';

import { outboundSettings } from '../config/outbound';
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function denied(): StepError {
  return new StepError('http destination is not allowed', false);
}

export function checkAddress(address: string, origin: string): void {
  const ip = ipaddr.process(address);
  const settings = outboundSettings(process.env);
  if (origin === settings.origin && ip.toString() === settings.address) return;
  if (
    ip.range() !== 'unicast' ||
    (ip instanceof ipaddr.IPv6 && !ip.match(ipaddr.parseCIDR('2000::/3'))) ||
    ip.toString() === '168.63.129.16'
  )
    throw denied();
  for (const item of Object.values(networkInterfaces()).flat()) {
    if (item && ipaddr.process(item.address).toString() === ip.toString())
      throw denied();
  }
  for (const [network, prefix] of settings.ranges) {
    if (network.kind() === ip.kind() && ip.match(network, prefix))
      throw denied();
  }
}

function checkUrl(url: URL): void {
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.href.length > MAX_URL_LENGTH
  )
    throw denied();
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) checkAddress(host, url.origin);
}

async function resolvePublic(
  host: string,
  origin: string,
  signal: AbortSignal,
) {
  const resolver = new Resolver();
  const cancel = () => resolver.cancel();
  signal.throwIfAborted();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const lookup = async (family: 4 | 6) => {
      try {
        const rows =
          family === 4
            ? await resolver.resolve4(host)
            : await resolver.resolve6(host);
        return rows.map((address) => ({ address, family }));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENODATA') return [];
        throw error;
      }
    };
    const addresses = (await Promise.all([lookup(4), lookup(6)])).flat();
    signal.throwIfAborted();
    if (!addresses.length)
      throw Object.assign(new Error('DNS has no addresses'), {
        code: 'ENOTFOUND',
      });
    for (const { address } of addresses) checkAddress(address, origin);
    return addresses;
  } finally {
    cancel();
    signal.removeEventListener('abort', cancel);
  }
}

function dispatcher(signal: AbortSignal): Agent {
  return new Agent({
    connections: 1,
    maxHeaderSize: 16384,
    maxResponseSize: outboundSettings(process.env).bytes,
    connect(options, done) {
      const host = options.hostname.replace(/^\[|\]$/g, '');
      const origin = new URL(options.protocol + '//' + options.host).origin;
      const establish = async () => {
        const answers = isIP(host)
          ? [{ address: host, family: isIP(host) }]
          : await resolvePublic(host, origin, signal);
        for (const { address } of answers) checkAddress(address, origin);
        signal.throwIfAborted();
        // net/tls отримує лише адреси з цього набору, а host і SNI лишаються оригінальними.
        buildConnector({
          signal,
          autoSelectFamily: true,
          lookup: (_name, opts, cb) => {
            const choices = answers.filter(
              (a) => !opts.family || a.family === opts.family,
            );
            if (!choices.length)
              return cb(
                Object.assign(new Error('no address'), { code: 'ENOTFOUND' }),
                '',
                0,
              );
            if (opts.all) cb(null, choices);
            else cb(null, choices[0].address, choices[0].family);
          },
        })(options, done);
      };
      void establish().catch((error: Error) => done(error, null));
    },
  });
}

async function readLimited(response: Response): Promise<string> {
  const max = outboundSettings(process.env).bytes;
  const encoding = response.headers.get('content-encoding')?.toLowerCase();
  if (encoding && encoding !== 'identity')
    throw new StepError('http response encoding is not supported', false);
  if (Number(response.headers.get('content-length')) > max)
    throw new StepError('http response is too large', false);
  const reader = response.body?.getReader();
  if (!reader) return '';
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      const chunk: Uint8Array = part.value as Uint8Array;
      size += chunk.length;
      if (size > max) throw new StepError('http response is too large', false);
      parts.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(parts, size).toString('utf8');
}

export async function outboundHttp(
  url: URL,
  method: string,
  headers: Headers,
  body: string | undefined,
  signal?: AbortSignal,
) {
  const controller = new AbortController();
  const deadlines = [
    controller.signal,
    AbortSignal.timeout(outboundSettings(process.env).timeoutMs),
  ];
  if (signal) deadlines.push(signal);
  const operation = AbortSignal.any(deadlines);
  let agent = dispatcher(operation);
  const correlation = getCorrelationId();
  if (correlation) headers.set('x-request-id', correlation);
  headers.set('accept-encoding', 'identity');
  try {
    for (let hops = 0; ; hops++) {
      checkUrl(url);
      const init: RequestInit & { dispatcher: Agent } = {
        dispatcher: agent,
        redirect: 'manual',
        method,
        headers: Array.from(headers.entries()),
        body,
        signal: operation,
      };
      const response = await outboundTransport.fetch(url, init);
      const location = response.headers.get('location');
      if (!REDIRECTS.has(response.status) || !location) {
        return {
          status: response.status,
          headers: response.headers,
          body: response.ok ? await readLimited(response) : '',
        };
      }
      if (hops >= 5 || !URL.canParse(location, url))
        throw new StepError(
          'http redirect is invalid or exceeds the limit',
          false,
        );
      const next = new URL(location, url);
      checkUrl(next);
      if (url.protocol === 'https:' && next.protocol !== 'https:')
        throw denied();
      if (
        (response.status === 303 && method !== 'HEAD') ||
        ((response.status === 301 || response.status === 302) &&
          method === 'POST')
      ) {
        method = 'GET';
        body = undefined;
        for (const name of [
          'content-type',
          'content-length',
          'content-encoding',
          'content-language',
          'content-location',
        ])
          headers.delete(name);
      }
      if (next.origin !== url.origin) {
        if (!['GET', 'HEAD'].includes(method) || body !== undefined)
          throw denied();
        headers = new Headers({ 'accept-encoding': 'identity' });
        if (correlation) headers.set('x-request-id', correlation);
      }
      await response.body?.cancel();
      await agent.destroy();
      agent = dispatcher(operation);
      url = next;
    }
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof StepError) throw cause;
    if (
      (cause as NodeJS.ErrnoException)?.code === 'UND_ERR_RES_EXCEEDED_MAX_SIZE'
    )
      throw new StepError('http response is too large', false);
    throw error;
  } finally {
    controller.abort();
    await agent.destroy();
  }
}
