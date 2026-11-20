import 'server-only';
import { frontendConfig } from './server-config';

/**
 * Сесія браузера (README, «Межа довіри браузера»). Браузер тримає лише непрозорий токен сесії,
 * який видав API (`POST /sessions`): httpOnly — недоступний JavaScript, `__Host-` + Secure —
 * лише HTTPS і лише цей origin, SameSite=Lax — не надсилається з чужих сайтів для POST. Без
 * Max-Age: cookie зникає разом із браузерною сесією, а строк дії сесії задає API.
 * Довгоживучий API-ключ, який користувач вводить при вході, живе лише в одному запиті до API.
 */
export const SECURE_SESSION_COOKIE = '__Host-ff_session';
/** Лише для локального http:// (COOKIE_SECURE=false): браузер не прийняв би `__Host-` без TLS. */
export const PLAIN_SESSION_COOKIE = 'ff_session';
/** Cookie попередньої версії з сирим API-ключем: видаляється, ключ не читається. */
export const LEGACY_KEY_COOKIE = 'ff_api_key';

export function sessionCookieName(): string {
  return frontendConfig().cookieSecure
    ? SECURE_SESSION_COOKIE
    : PLAIN_SESSION_COOKIE;
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: frontendConfig().cookieSecure,
    sameSite: 'lax' as const,
    path: '/',
  };
}

/** Токен сесії має форму `ffs_` + 64 hex; інше значення в cookie не передаємо в API. */
export function validSessionToken(
  value: string | undefined,
): string | undefined {
  return value && /^ffs_[0-9a-f]{64}$/.test(value) ? value : undefined;
}
