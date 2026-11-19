/**
 * Значення `tenantId` за замовчуванням — тенант із контексту транзакції (`app.tenant_id`). Код
 * завжди передає `tenantId` явно; DEFAULT лише страхує, а політика RLS (`WITH CHECK`) однаково
 * відхилить рядок, чий `tenantId` не збігається з контекстом.
 */
export const TENANT_ID_DEFAULT = (): string => 'app_current_tenant()';
