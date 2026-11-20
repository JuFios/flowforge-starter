import { BlockList, isIP } from 'node:net';

/**
 * IP клієнта фронтенду за ланцюжком довірених проксі — та сама семантика, що й Express
 * `trust proxy` в API (`TRUST_PROXY`): `false`, кількість переходів 1..10 або перелік адрес і
 * підмереж (`loopback`, `linklocal`, `uniquelocal`). `true` не приймається: тоді клієнт сам
 * задавав би собі IP через X-Forwarded-For.
 *
 * Next.js 14 сам ставить `x-forwarded-for` лише якщо його немає (`??=` у base-server), тож
 * значення від браузера дійшло б до API як довірене. Тому власний сервер (server.ts) обчислює
 * адресу тут з адреси сокета й перезаписує заголовок до передачі запиту в Next.
 */
export type TrustProxy = false | number | BlockList;

const NAMED: Record<string, Array<[string, number, 'ipv4' | 'ipv6']>> = {
  loopback: [
    ['127.0.0.0', 8, 'ipv4'],
    ['::1', 128, 'ipv6'],
  ],
  linklocal: [
    ['169.254.0.0', 16, 'ipv4'],
    ['fe80::', 10, 'ipv6'],
  ],
  uniquelocal: [
    ['10.0.0.0', 8, 'ipv4'],
    ['172.16.0.0', 12, 'ipv4'],
    ['192.168.0.0', 16, 'ipv4'],
    ['fc00::', 7, 'ipv6'],
  ],
};

export function parseTrustProxy(value: string | undefined): TrustProxy {
  const trimmed = (value ?? '').trim();
  if (trimmed === '' || trimmed === 'false') return false;
  if (/^\d+$/.test(trimmed)) {
    const hops = Number(trimmed);
    if (hops >= 1 && hops <= 10) return hops;
    throw new Error('FRONTEND_TRUST_PROXY: hop count must be 1..10');
  }
  const list = new BlockList();
  for (const entry of trimmed.split(',').map((e) => e.trim())) {
    const named = NAMED[entry];
    if (named) {
      for (const [address, prefix, family] of named)
        list.addSubnet(address, prefix, family);
      continue;
    }
    const [address, prefix, ...rest] = entry.split('/');
    const family = isIP(address);
    if (family === 0 || rest.length > 0)
      throw new Error(`FRONTEND_TRUST_PROXY: invalid entry ${entry}`);
    const type = family === 4 ? 'ipv4' : 'ipv6';
    if (prefix === undefined) {
      list.addAddress(address, type);
      continue;
    }
    const bits = Number(prefix);
    if (
      !/^\d{1,3}$/.test(prefix) ||
      bits < 1 ||
      bits > (family === 4 ? 32 : 128)
    )
      throw new Error(`FRONTEND_TRUST_PROXY: invalid prefix in ${entry}`);
    list.addSubnet(address, bits, type);
  }
  return list;
}

/** `::ffff:1.2.3.4` → `1.2.3.4`: та сама адреса не повинна потрапляти у два різні відра. */
export function normalizeIp(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return mapped ? mapped[1] : address;
}

function trusted(list: BlockList, address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return list.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * Адреса клієнта: справа наліво по ланцюжку `[сокет, ...X-Forwarded-For у зворотному порядку]`,
 * пропускаючи довірені проксі. Невалідний запис у XFF зупиняє пошук: далі нього не довіряємо.
 */
export function clientIp(
  socketAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  trust: TrustProxy,
): string {
  const peer = normalizeIp(socketAddress ?? '');
  if (trust === false) return peer;
  const header = Array.isArray(forwardedFor)
    ? forwardedFor.join(',')
    : (forwardedFor ?? '');
  const hops = header
    .split(',')
    .map((part) => normalizeIp(part.trim()))
    .filter((part) => part !== '')
    .reverse();
  const chain = [peer, ...hops];
  if (typeof trust === 'number') {
    const candidate = chain[Math.min(trust, chain.length - 1)];
    return isIP(candidate) ? candidate : peer;
  }
  for (let i = 0; i < chain.length; i++) {
    const address = chain[i];
    if (isIP(address) === 0) return chain[Math.max(0, i - 1)];
    if (i === chain.length - 1 || !trusted(trust, address)) return address;
  }
  return peer;
}

/** Чи довіряємо безпосередньому співрозмовнику (адресі сокета) як проксі. */
export function peerIsTrustedProxy(
  socketAddress: string | undefined,
  trust: TrustProxy,
): boolean {
  if (trust === false) return false;
  if (typeof trust === 'number') return true;
  return trusted(trust, normalizeIp(socketAddress ?? ''));
}
