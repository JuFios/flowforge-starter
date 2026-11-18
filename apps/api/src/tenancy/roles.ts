/**
 * Групові ролі Postgres (NOLOGIN), які створює міграція TenantIsolation. Login-ролі процесів —
 * члени однієї з них (`db:provision`).
 */
export const API_ROLE = 'flowforge_api_role';
export const WORKER_ROLE = 'flowforge_worker_role';
/** Власник SECURITY DEFINER-функцій і тригерів; BYPASSRLS, без LOGIN. */
export const SYSTEM_ROLE = 'flowforge_system';
