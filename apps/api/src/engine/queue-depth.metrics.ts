import { Injectable } from '@nestjs/common';
import { Counter, Gauge } from 'prom-client';
import { MetricsService } from '../observability/metrics.service';
import { SystemDb } from '../tenancy/system-db';

/** Скільки знімок глибини черги вважається свіжим (скрейпи частіші — з кешу). */
const CACHE_MS = 5_000;

type Depth = Array<{ tenantId: string; queued: number; running: number }>;

/**
 * `flowforge_queue_depth{tenant_id,state}` — задачі тенанта в черзі (`queued`, включно з паузами)
 * і в роботі (`running`), з обліку `tenant_usage` (без сканування задач). Серія — для кожного
 * тенанта з незавершеними задачами; gauge скидається на кожному зборі, тож тенант, що спорожнів,
 * зникає (кардинальність = кількість активних тенантів). Значення глобальні: кожен воркер віддає
 * однакові, агрегувати — `max by (tenant_id, state)` (docs/operations.md, «Спостережуваність»).
 *
 * Помилка читання (БД недоступна, таймаут) — +1 до `flowforge_queue_depth_collect_errors_total` на
 * кожне невдале читання (а не на кожен скрейп, що на нього чекав) і порожній gauge замість застарілих
 * значень.
 */
@Injectable()
export class QueueDepthMetrics {
  readonly collectErrors: Counter;
  private cached?: { at: number; depth: Depth };
  private inFlight?: Promise<Depth>;
  /** Поточний збір gauge: лічильник помилок чекає на нього, щоб віддати вже свій результат. */
  private collecting?: Promise<void>;

  constructor(
    metrics: MetricsService,
    private readonly system: SystemDb,
  ) {
    const registers = [metrics.registry];
    // Gauge — першим: реєстр збирає метрики в порядку реєстрації, тож лічильник помилок нижче
    // починає збір, коли збір gauge уже запущено, і чекає на нього.
    const gauge: Gauge<'tenant_id' | 'state'> = new Gauge({
      name: 'flowforge_queue_depth',
      help: 'Jobs of each tenant with unfinished work: queued (including delays) and running',
      labelNames: ['tenant_id', 'state'],
      registers,
      collect: () => {
        this.collecting = this.fill(gauge);
        return this.collecting;
      },
    });
    this.collectErrors = new Counter({
      name: 'flowforge_queue_depth_collect_errors_total',
      help: 'Failed reads of the per-tenant queue depth',
      registers,
      collect: async () => {
        await this.collecting;
      },
    });
  }

  private async fill(gauge: Gauge<'tenant_id' | 'state'>): Promise<void> {
    gauge.reset();
    let depth: Depth;
    try {
      depth = await this.depth();
    } catch {
      // Помилку вже враховано один раз у спільному читанні (readDepth): тут — лише порожній gauge.
      return;
    }
    for (const { tenantId, queued, running } of depth) {
      gauge.set({ tenant_id: tenantId, state: 'queued' }, queued);
      gauge.set({ tenant_id: tenantId, state: 'running' }, running);
    }
  }

  /** Одне читання з БД; невдале рахується тут, а не в кожному скрейпі, що на нього чекає. */
  private async readDepth(): Promise<Depth> {
    try {
      return await this.system.queueDepthByTenant();
    } catch (err) {
      this.collectErrors.inc();
      throw err;
    }
  }

  /** Знімок глибини: з кешу або одним запитом на всі одночасні скрейпи. */
  private async depth(): Promise<Depth> {
    if (this.cached && performance.now() - this.cached.at < CACHE_MS)
      return this.cached.depth;
    this.inFlight ??= this.readDepth().finally(() => {
      this.inFlight = undefined;
    });
    const depth = await this.inFlight;
    this.cached = { at: performance.now(), depth };
    return depth;
  }
}
