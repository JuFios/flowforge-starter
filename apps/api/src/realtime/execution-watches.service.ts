import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { toSafeError } from '../observability/safe-error';
import { SystemDb } from '../tenancy/system-db';
import { TenantDb } from '../tenancy/tenant-db';

/** Строк дії підписки в БД; продовжується кожні 15 с (таймер шлюзу), тож витримує два пропуски. */
export const WATCH_TTL_MS = 45_000;

interface Watch {
  tenantId: string;
  executionId: string;
  /** Скільки сокетів цього інстансу дивляться виконання. */
  sockets: number;
  /** Рядок підписки вставлено (або спроба завершилась помилкою). */
  ready: Promise<void>;
}

/**
 * Підписки цього інстансу API на виконання в таблиці `realtime_watches` (docs/architecture.md,
 * «Сповіщення лише для переглянутих виконань»): тригер надсилає `ff_execution` лише для виконань із
 * чинною підпискою. Рядок один на виконання й інстанс, скільки б сокетів його не дивились.
 *
 * Операції з рядком одного виконання (вставка, видалення) виконуються по черзі: видалення після
 * закриття останнього сокета не може закомітитись після вставки нової підписки на те саме виконання
 * й прибрати її.
 */
@Injectable()
export class ExecutionWatches {
  private readonly logger = new Logger(ExecutionWatches.name);
  /** Ідентифікатор процесу: рядки зниклого інстансу ніхто не продовжує, і вони спливають. */
  readonly instanceId = randomUUID();
  private readonly watches = new Map<string, Watch>();
  /** Остання незавершена операція з рядком виконання (ключ — `tenant:execution`). */
  private readonly pending = new Map<string, Promise<void>>();

  constructor(
    private readonly db: TenantDb,
    private readonly system: SystemDb,
  ) {}

  /** Ставить операцію з рядком виконання `key` після попередньої (успішної чи ні). */
  private enqueue(key: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.pending.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    const settled = next.catch(() => undefined);
    this.pending.set(key, settled);
    void settled.then(() => {
      if (this.pending.get(key) === settled) this.pending.delete(key);
    });
    return next;
  }

  /**
   * Починає підписку сокета. Проміс виконується, коли рядок підписки закомічено: лише після цього
   * читання знімка гарантовано не пропустить зміну — `FOR SHARE` чекає на транзакцію, що вже змінює
   * виконання (її тригер підписки ще не бачив), а всі наступні тригери бачать підписку.
   */
  watch(tenantId: string, executionId: string): Promise<void> {
    const key = `${tenantId}:${executionId}`;
    const existing = this.watches.get(key);
    if (existing) {
      existing.sockets++;
      return existing.ready;
    }
    const watch: Watch = {
      tenantId,
      executionId,
      sockets: 1,
      ready: this.enqueue(key, () =>
        this.db.run(tenantId, async (em) => {
          await em.query(
            'SELECT 1 FROM executions WHERE id = $1 AND "tenantId" = $2 FOR SHARE',
            [executionId, tenantId],
          );
          await em.query(
            `INSERT INTO realtime_watches ("executionId", "tenantId", "instanceId", "expiresAt")
             VALUES ($1, $2, $3, clock_timestamp() + make_interval(secs => $4))
             ON CONFLICT ("executionId", "instanceId") DO UPDATE SET "expiresAt" = EXCLUDED."expiresAt"`,
            [executionId, tenantId, this.instanceId, WATCH_TTL_MS / 1000],
          );
        }),
      ),
    };
    this.watches.set(key, watch);
    // Невдала вставка: сокети закриваються, а наступна підписка спробує знову.
    watch.ready.catch(() => {
      if (this.watches.get(key) === watch && watch.sockets === 0)
        this.watches.delete(key);
    });
    return watch.ready;
  }

  /** Сокет більше не дивиться виконання; останній прибирає рядок підписки. */
  unwatch(tenantId: string, executionId: string): void {
    const key = `${tenantId}:${executionId}`;
    const watch = this.watches.get(key);
    if (!watch || --watch.sockets > 0) return;
    this.watches.delete(key);
    this.enqueue(key, async () => {
      // Нова підписка на те саме виконання стала в чергу після цього видалення й вставить рядок
      // знову; видаляти його тоді не потрібно.
      if (this.watches.has(key)) return;
      await this.db.run(tenantId, (em) =>
        em.query(
          'DELETE FROM realtime_watches WHERE "executionId" = $1 AND "tenantId" = $2 AND "instanceId" = $3',
          [executionId, tenantId, this.instanceId],
        ),
      );
    }).catch((err: unknown) =>
      // Рядок спливе сам або його прибере наступне продовження.
      this.logger.warn(
        { error: toSafeError(err) },
        'realtime watch removal failed',
      ),
    );
  }

  /**
   * Продовжує всі підписки інстансу, відновлює відсутні й прибирає зайві. Повертає, скільки рядків
   * довелося відновити: після цього шлюз перечитує знімки, бо зміни між зникненням рядка й
   * відновленням сповіщення не дали.
   */
  renew(): Promise<number> {
    const list = [...this.watches.values()];
    return this.system.renewRealtimeWatches(
      this.instanceId,
      list.map((w) => w.executionId),
      list.map((w) => w.tenantId),
      WATCH_TTL_MS,
    );
  }

  /**
   * Завершення інстансу: дочікується вставок і видалень у дорозі (інакше вставка, закомічена після
   * прибирання, жила б до WATCH_TTL_MS) і прибирає всі рядки інстансу.
   */
  async release(): Promise<void> {
    this.watches.clear();
    await Promise.all([...this.pending.values()]);
    await this.system.renewRealtimeWatches(
      this.instanceId,
      [],
      [],
      WATCH_TTL_MS,
    );
  }
}
