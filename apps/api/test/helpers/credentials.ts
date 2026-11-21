import { randomBytes } from 'node:crypto';
import { TEST_ADMIN_TOKEN } from './test-env';

/**
 * Облікові дані, які генерує клієнт (ТЗ 4: сервер їх не видає й не повертає). Тести, як і оператор
 * за README, беруть 32 випадкові байти в hex.
 */
export const newApiKey = () => 'ff_' + randomBytes(32).toString('hex');
export const newSecret = () => randomBytes(32).toString('hex');

export interface ApiTenant {
  id: string;
  name: string;
  apiKey: string;
  webhookSecret: string;
  webhookKeyId: string;
}

/** Нові облікові дані для тіла POST /tenants. */
export function newCredentials() {
  return { apiKey: newApiKey(), webhookSecret: newSecret() };
}

/** Тіло POST /tenants з новими обліковими даними. */
export function tenantBody(name: string, extra: Record<string, unknown> = {}) {
  return { name, apiKey: newApiKey(), webhookSecret: newSecret(), ...extra };
}

/** Створює тенанта через адмін-API; облікові дані — ті, що згенерував тест. */
export async function createTenantViaApi(
  baseUrl: string,
  name: string,
  extra: Record<string, unknown> = {},
): Promise<ApiTenant> {
  const body = tenantBody(name, extra);
  const res = await fetch(baseUrl + '/tenants', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-admin-token': TEST_ADMIN_TOKEN,
    },
    body: JSON.stringify(body),
  });
  if (res.status !== 201)
    throw new Error(`POST /tenants → ${res.status}: ${await res.text()}`);
  const created = (await res.json()) as { id: string; webhookKeyId: string };
  return {
    id: created.id,
    name,
    apiKey: body.apiKey,
    webhookSecret: body.webhookSecret,
    webhookKeyId: created.webhookKeyId,
  };
}
