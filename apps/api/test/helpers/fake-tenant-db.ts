import type { EntityManager } from 'typeorm';
import type { TenantDb, TenantTransaction } from '../../src/tenancy/tenant-db';

/**
 * TenantDb для unit-тестів: транзакції виконуються з переданим EntityManager-заглушкою, контекст
 * тенанта лише запам'ятовується. Перевірка RLS — в інтеграційних тестах на справжньому Postgres.
 */
export function fakeTenantDb(em: Partial<EntityManager> = {}): TenantDb {
  const manager = em as EntityManager;
  const transaction = <T>(
    fn: (tx: TenantTransaction) => Promise<T>,
  ): Promise<T> => {
    let tenant: string | undefined;
    return fn({
      em: manager,
      get tenantId() {
        return tenant;
      },
      enter: (tenantId: string) => {
        tenant = tenantId;
        return Promise.resolve();
      },
    });
  };
  return {
    run: <T>(_tenantId: string, fn: (m: EntityManager) => Promise<T>) =>
      fn(manager),
    transaction,
  } as unknown as TenantDb;
}
