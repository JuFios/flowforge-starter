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
import { outboundSettings } from '../config/outbound';
import { getCorrelationId } from '../observability/correlation';
import { MAX_URL_LENGTH } from '../workflows/definition';
import { StepError } from './step-error';

/** Транспорт запиту; тести підміняють його, щоб перевірити рішення до відправлення. */
export const outboundTransport = { fetch: send };
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function denied(): StepError {
  return new StepError('http destination is not allowed', false);
}

type OutboundSettings = ReturnType<typeof outboundSettings>;
const SETTING_NAMES = [
  'HTTP_FIXTURE_ORIGIN',
  'HTTP_FIXTURE_ADDRESS',
  'HTTP_DENY_CIDRS',
  'HTTP_STEP_TIMEOUT_MS',
  'HTTP_RESPONSE_BYTES',
] as const;
let cached: { key: string; settings: OutboundSettings } | undefined;

/**
 * Налаштування з оточення, розібрані один раз на набір значень (перевірка під час старту —
 * env.validation.ts). Тести змінюють оточення між сценаріями, тож ключ — самі значення.
 */
function settingsNow(): OutboundSettings {
  const key = JSON.stringify(SETTING_NAMES.map((name) => process.env[name]));
  if (cached?.key !== key)
    cached = { key, settings: outboundSettings(process.env) };
  return cached.settings;
}

/** Адреси інтерфейсів самого хоста (зокрема публічні): з'єднання з ними — доступ до хоста. */
function hostAddresses(): Set<string> {
  const own = new Set<string>();
  for (const item of Object.values(networkInterfaces()).flat())
    if (item) own.add(ipaddr.process(item.address).toString());
  return own;
}

export function checkAddress(
  address: string,
  origin: string,
  settings = settingsNow(),
  own = hostAddresses(),
): void {
  const ip = ipaddr.process(address);
  if (origin === settings.origin && ip.toString() === settings.address) return;
  if (
    ip.range() !== 'unicast' ||
    (ip instanceof ipaddr.IPv6 && !ip.match(ipaddr.parseCIDR('2000::/3'))) ||
    ip.toString() === '168.63.129.16'
  )
    throw denied();
  if (own.has(ip.toString())) throw denied();
  for (const [network, prefix] of settings.ranges) {
    if (network.kind() === ip.kind() && ip.match(network, prefix))
      throw denied();
  }
}

/**
 * URL endpoint-а сповіщень під час збереження налаштувань: схема `https:` (або тестовий приймач
 * HTTP_FIXTURE_ORIGIN), без облікових даних, у межах довжини, і кожна адреса з DNS — дозволена.
 * Це рання відмова тенанту; кожна спроба доставки однаково перевіряє адресу під час з'єднання.
 */
export async function assertNotificationUrl(
  raw: string,
  signal: AbortSignal = AbortSignal.timeout(5_000),
): Promise<URL> {
  if (!URL.canParse(raw)) throw denied();
  const url = new URL(raw);
  const settings = settingsNow();
  if (url.protocol !== 'https:' && url.origin !== settings.origin)
    throw denied();
  checkUrl(url);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!isIP(host)) {
    const own = hostAddresses();
    for (const { address } of await resolveAll(host, signal))
      checkAddress(address, url.origin, settings, own);
  }
  return url;
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

/** Усі A та AAAA імені; перевіряє їх `connect` (змішаний набір відхиляється цілком). */
async function resolveAll(host: string, signal: AbortSignal) {
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
    maxResponseSize: settingsNow().bytes,
    connect(options, done) {
      const host = options.hostname.replace(/^\[|\]$/g, '');
      const origin = new URL(options.protocol + '//' + options.host).origin;
      const establish = async () => {
        const answers = isIP(host)
          ? [{ address: host, family: isIP(host) }]
          : await resolveAll(host, signal);
        const settings = settingsNow(),
          own = hostAddresses();
        for (const { address } of answers)
          checkAddress(address, origin, settings, own);
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
  const max = settingsNow().bytes;
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

/** Як запит поводиться з відповіддю, крім спільної політики адрес. */
export interface OutboundOptions {
  /**
   * `follow` — до п'яти переходів із перевіркою кожного (кроки `http`); `reject` — будь-яка 3xx
   * повертається як є. Сповіщення не йдуть за редиректами: 301/302/303 перетворили б POST на GET
   * без тіла, і отримувач із 200 на такий запит зарахувався б як доставка.
   */
  redirects?: 'follow' | 'reject';
  /** Таймаут усього запиту, мс; не більше за HTTP_STEP_TIMEOUT_MS. */
  timeoutMs?: number;
  /** false — тіло відповіді не читається (лише скасовується). */
  readBody?: boolean;
}

export async function outboundHttp(
  url: URL,
  method: string,
  headers: Headers,
  body: string | undefined,
  signal?: AbortSignal,
  { redirects = 'follow', timeoutMs, readBody = true }: OutboundOptions = {},
) {
  const controller = new AbortController();
  const limit = settingsNow().timeoutMs;
  const deadlines = [
    controller.signal,
    AbortSignal.timeout(Math.min(timeoutMs ?? limit, limit)),
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
      if (
        !REDIRECTS.has(response.status) ||
        !location ||
        redirects === 'reject'
      ) {
        if (!readBody) {
          // Статус уже відомий; помилка тіла (обрив після заголовків) результату не змінює.
          await response.body?.cancel().catch(() => undefined);
          return {
            status: response.status,
            headers: response.headers,
            body: '',
          };
        }
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
