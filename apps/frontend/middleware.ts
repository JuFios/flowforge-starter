import { NextRequest, NextResponse } from 'next/server';

/**
 * Для кожної сторінки: Content-Security-Policy з nonce (скрипти — лише власні й з цим nonce,
 * з'єднання — лише з власним origin, вбудовування в чужі фрейми заборонене) і перехід на вхід без
 * сесії. Cookie попередньої версії з сирим API-ключем видаляється, а ключ із нього не читається.
 */
const SESSION_COOKIES = ['__Host-ff_session', 'ff_session'];
const LEGACY_KEY_COOKIE = 'ff_api_key';
const PUBLIC_PATHS = ['/login'];

function contentSecurityPolicy(nonce: string, dev: boolean): string {
  return [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    // React ставить атрибути style; зовнішніх стилів немає.
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data:`,
    `font-src 'self'`,
    `connect-src 'self'`,
    `frame-ancestors 'none'`,
    `base-uri 'none'`,
    `form-action 'self'`,
    `object-src 'none'`,
  ].join('; ');
}

export function middleware(req: NextRequest): NextResponse {
  const { pathname, search } = req.nextUrl;
  const hasSession = SESSION_COOKIES.some((name) => req.cookies.has(name));

  if (!hasSession && !PUBLIC_PATHS.includes(pathname)) {
    const login = req.nextUrl.clone();
    login.pathname = '/login';
    login.search = '';
    // Куди повернутися після входу — лише відносний шлях цього застосунку.
    if (pathname !== '/')
      login.searchParams.set('next', `${pathname}${search}`);
    const res = NextResponse.redirect(login);
    if (req.cookies.has(LEGACY_KEY_COOKIE))
      res.cookies.delete(LEGACY_KEY_COOKIE);
    return res;
  }

  const nonce = btoa(crypto.randomUUID());
  const csp = contentSecurityPolicy(
    nonce,
    process.env.NODE_ENV !== 'production',
  );
  const headers = new Headers(req.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', csp);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set('content-security-policy', csp);
  res.headers.set('referrer-policy', 'no-referrer');
  res.headers.set('x-content-type-options', 'nosniff');
  res.headers.set('x-frame-options', 'DENY');
  res.headers.set('cache-control', 'private, no-store');
  if (req.cookies.has(LEGACY_KEY_COOKIE)) res.cookies.delete(LEGACY_KEY_COOKIE);
  return res;
}

export const config = {
  // Сторінки; API-маршрути фронтенду й статичні файли Next — без цієї обробки.
  matcher: ['/((?!api/|_next/static|_next/image|favicon.ico).*)'],
};
