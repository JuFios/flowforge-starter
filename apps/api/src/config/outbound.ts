import ipaddr from 'ipaddr.js';

function limit(
  env: Record<string, unknown>,
  name: string,
  fallback: number,
  max: number,
): number {
  const value = env[name] ?? String(fallback);
  if (
    typeof value !== 'string' ||
    !/^[1-9][0-9]{0,8}$/.test(value) ||
    Number(value) > max
  )
    throw new Error('Invalid ' + name);
  return Number(value);
}
export function outboundSettings(env: Record<string, unknown>) {
  const origin = env.HTTP_FIXTURE_ORIGIN,
    address = env.HTTP_FIXTURE_ADDRESS;
  if (origin !== undefined || address !== undefined) {
    if (
      typeof origin !== 'string' ||
      typeof address !== 'string' ||
      !URL.canParse(origin) ||
      new URL(origin).origin !== origin ||
      new URL(origin).protocol !== 'http:' ||
      !new URL(origin).port ||
      !ipaddr.isValid(address) ||
      !['private', 'loopback'].includes(ipaddr.process(address).range())
    )
      throw new Error('Invalid HTTP fixture origin/address');
  }
  const cidrs = env.HTTP_DENY_CIDRS ?? '';
  if (typeof cidrs !== 'string' || cidrs.length > 4096)
    throw new Error('Invalid HTTP_DENY_CIDRS');
  const ranges = cidrs
    ? cidrs.split(',').map((value) => {
        if (!ipaddr.isValidCIDR(value.trim()))
          throw new Error('Invalid HTTP_DENY_CIDRS');
        return ipaddr.parseCIDR(value.trim());
      })
    : [];
  return {
    origin,
    address,
    ranges,
    timeoutMs: limit(env, 'HTTP_STEP_TIMEOUT_MS', 15000, 60000),
    bytes: limit(env, 'HTTP_RESPONSE_BYTES', 1048576, 1048576),
  };
}
