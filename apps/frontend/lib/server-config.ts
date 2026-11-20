/**
 * Конфігурація серверної частини фронтенду (`.env.example`). Читається один раз; невалідне
 * значення зупиняє процес на старті, а не дає тиху поведінку за замовчуванням.
 */
export interface FrontendConfig {
  /** Інстанси API; на помилці з'єднання проксі переходить до наступного. */
  apiUrls: URL[];
  /** Таймаут одного запиту до API, мс. */
  apiTimeoutMs: number;
  /** Публічний origin фронтенду для перевірки Origin; без нього — origin із заголовка Host. */
  publicOrigin: string | undefined;
  /** Cookie лише через HTTPS (`__Host-` префікс). false — тільки для локального http. */
  cookieSecure: boolean;
}

function urls(raw: string | undefined): URL[] {
  const list = (raw ?? 'http://localhost:3000')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (list.length === 0 || list.length > 8)
    throw new Error('API_URLS must list 1..8 API instances');
  return list.map((value) => {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      throw new Error('API_URLS entries must be http(s) URLs');
    if (url.pathname !== '/' || url.search || url.hash)
      throw new Error('API_URLS entries must be origins without a path');
    return url;
  });
}

function int(name: string, fallback: number, lo: number, hi: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < lo || value > hi)
    throw new Error(`${name} must be an integer ${lo}..${hi}`);
  return value;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

let cached: FrontendConfig | undefined;

export function frontendConfig(): FrontendConfig {
  if (cached) return cached;
  const origin = process.env.PUBLIC_ORIGIN?.trim();
  if (origin) {
    const parsed = new URL(origin);
    if (parsed.origin !== origin)
      throw new Error(
        'PUBLIC_ORIGIN must be an origin like https://app.example.com',
      );
  }
  cached = {
    // API_URL — назва з попередньої версії (одна адреса).
    apiUrls: urls(process.env.API_URLS ?? process.env.API_URL),
    apiTimeoutMs: int('API_TIMEOUT_MS', 15_000, 1_000, 120_000),
    publicOrigin: origin || undefined,
    cookieSecure: bool('COOKIE_SECURE', true),
  };
  return cached;
}
