import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ідентифікатор тенанта, що йде в контекст БД, — лише UUID, інакше помилка програміста. */
export function assertTenantId(tenantId: string): string {
  if (typeof tenantId !== 'string' || !UUID.test(tenantId))
    throw new Error('tenant context requires a tenant UUID');
  return tenantId;
}

/** Транзакція, у якій контекст тенанта задається один раз і не змінюється. */
export interface TenantTransaction {
  readonly em: EntityManager;
  /** Поточний тенант транзакції або undefined, поки його не задано. */
  readonly tenantId: string | undefined;
  /**
   * Задає тенанта транзакції (`set_config('app.tenant_id', …, true)` — значення діє до кінця
   * транзакції й скидається на COMMIT/ROLLBACK). Повторно — лише той самий тенант.
   */
  enter(tenantId: string): Promise<void>;
}

/**
 * Єдина точка доступу застосунку до тенантних даних. Кожна операція — транзакція, перший оператор
 * якої задає `app.tenant_id`; політики RLS пропускають лише рядки цього тенанта, а без контексту
 * не видно нічого. Значення транзакційно-локальне, тож з'єднання, повернуте в пул, контексту не
 * несе.
 *
 * Правило: усередині транзакції немає зовнішнього I/O (HTTP-кроків, очікувань) — транзакція тримає
 * з'єднання з пулу. Сервер страхує idle_in_transaction_session_timeout.
 */
@Injectable()
export class TenantDb {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  /**
   * Транзакція в контексті тенанта. Невалідний id — відхилений проміс ще до звернення до БД
   * (а не синхронний виняток, який обійшов би `.catch` викликача).
   */
  async run<T>(
    tenantId: string,
    fn: (em: EntityManager) => Promise<T>,
  ): Promise<T> {
    assertTenantId(tenantId);
    return this.transaction(async (tx) => {
      await tx.enter(tenantId);
      return fn(tx.em);
    });
  }

  /**
   * Транзакція з контекстом, що задається один раз (`enter`) і не змінюється: основа `run`.
   * Спроба перейти до іншого тенанта в тій самій транзакції — помилка.
   */
  transaction<T>(fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
    return this.ds.transaction(async (em) => {
      let current: string | undefined;
      let requested: string | undefined;
      let setting: Promise<void> | undefined;
      const tx: TenantTransaction = {
        em,
        get tenantId() {
          return current;
        },
        async enter(tenantId: string) {
          assertTenantId(tenantId);
          if (requested !== undefined && requested !== tenantId)
            throw new Error('a transaction cannot switch tenants');
          requested = tenantId;
          setting ??= em
            .query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId])
            .then(() => {
              current = tenantId;
            });
          await setting;
        },
      };
      return fn(tx);
    });
  }
}
