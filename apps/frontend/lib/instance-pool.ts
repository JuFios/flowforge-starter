/**
 * Вибір інстансу API для проксі фронтенду: HTTP (`lib/upstream.ts`) і WebSocket upgrade
 * (`lib/upgrade-proxy.ts`). Пасивний запобіжник замість активних health-check-ів.
 *
 * - Першим пробується інстанс, що відповів останнім (`preferred`).
 * - Невизначена відмова (таймаут, обрив, помилка з'єднання) робить інстанс підозрілим на cooldown.
 *   Підозрілий стоїть у порядку перебору після всіх справних, тому завислий API, що приймає
 *   з'єднання й мовчить, не перехоплює кожен наступний запит, поки поруч є справний. Але і не
 *   виключається зовсім: коли інші не відповідають, підозрілий усе одно пробується.
 * - Будь-яка відповідь (HTTP-статус чи 101) знімає підозру. Інстанс, що відмовив знову після
 *   спливання cooldown, отримує вдвічі довший, до `maxCooldownMs`.
 *
 * Свідчення впорядковані за початком спроби (`begin`), а не за моментом результату. Спроби, що
 * почалися до позначки, належать до того самого інциденту: їхні пізні таймаути не подовжують
 * cooldown, а пізній успіх не повертає першість щойно завислому інстансу. Так само відмова спроби,
 * почата до новішої відповіді інстансу, його вже не позначає: він відповідав після неї.
 *
 * Стан живе в пам'яті процесу, один пул на процес для HTTP і WebSocket (`sharedInstancePool`).
 * Це лише порядок перебору, а не дані: після рестарту фронтенду перебір знову починається з першої
 * адреси `API_URLS`.
 */
export const BASE_COOLDOWN_MS = 30_000;
export const MAX_COOLDOWN_MS = 300_000;

export interface InstancePoolOptions {
  baseCooldownMs?: number;
  maxCooldownMs?: number;
  /** Годинник для cooldown (у тестах — керований). */
  now?: () => number;
}

export class InstancePool {
  private preferred = 0;
  /** Лічильник початих спроб: порядок свідчень. */
  private sequence = 0;
  /** Номер останньої спроби, початої до позначки інстансу (0 — не позначався). */
  private readonly markedAt: number[];
  /** Номер найновішої спроби, на яку інстанс відповів (0 — ще не відповідав). */
  private readonly answeredAt: number[];
  /** Поспіль відмов без успіху: визначає тривалість cooldown. */
  private readonly failures: number[];
  /** До якого моменту інстанс підозрілий (0 — справний). */
  private readonly suspectUntil: number[];
  private readonly baseCooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly now: () => number;

  constructor(
    readonly size: number,
    options: InstancePoolOptions = {},
  ) {
    if (!Number.isInteger(size) || size < 1)
      throw new Error('InstancePool needs at least one instance');
    this.baseCooldownMs = options.baseCooldownMs ?? BASE_COOLDOWN_MS;
    this.maxCooldownMs = options.maxCooldownMs ?? MAX_COOLDOWN_MS;
    this.now = options.now ?? Date.now;
    this.markedAt = new Array<number>(size).fill(0);
    this.answeredAt = new Array<number>(size).fill(0);
    this.failures = new Array<number>(size).fill(0);
    this.suspectUntil = new Array<number>(size).fill(0);
  }

  /** Порядок перебору: справні по колу від `preferred`, далі підозрілі — хто раніше відбуде cooldown. */
  order(): number[] {
    const now = this.now();
    const healthy: number[] = [];
    const suspect: number[] = [];
    for (let step = 0; step < this.size; step++) {
      const index = (this.preferred + step) % this.size;
      (this.suspectUntil[index] > now ? suspect : healthy).push(index);
    }
    suspect.sort((a, b) => this.suspectUntil[a] - this.suspectUntil[b]);
    return healthy.concat(suspect);
  }

  /** Номер спроби; передається в `succeeded` чи `failed` з її результатом. */
  begin(): number {
    return ++this.sequence;
  }

  /** Інстанс відповів. Спроба, почата до останньої позначки, підозру не знімає. */
  succeeded(index: number, attempt: number): void {
    if (attempt <= this.markedAt[index]) return;
    this.answeredAt[index] = Math.max(this.answeredAt[index], attempt);
    this.preferred = index;
    this.failures[index] = 0;
    this.suspectUntil[index] = 0;
  }

  /**
   * Невизначена відмова. Спроба, почата до останньої позначки, — той самий інцидент; почата до
   * новішої відповіді — застаріле свідчення.
   */
  failed(index: number, attempt: number): void {
    if (attempt <= this.markedAt[index] || attempt < this.answeredAt[index])
      return;
    this.markedAt[index] = this.sequence;
    this.failures[index] = Math.min(this.failures[index] + 1, 32);
    this.suspectUntil[index] =
      this.now() +
      Math.min(
        this.maxCooldownMs,
        this.baseCooldownMs * 2 ** (this.failures[index] - 1),
      );
    if (this.preferred === index) {
      const next = this.order().find((other) => other !== index);
      if (next !== undefined) this.preferred = next;
    }
  }
}

const POOLS = Symbol.for('flowforge.frontend.instancePools');
type PoolRegistry = { [POOLS]?: Map<string, InstancePool> };

/**
 * Один пул на процес для того самого `API_URLS`: HTTP-маршрути Next і WebSocket-проксі власного
 * сервера живуть в одному процесі, але в різних графах модулів, тож спільний стан — через
 * `globalThis`. Тоді завислий інстанс, виявлений одним проксі, обходить і інший. Ключ — список
 * origin-ів: різних списків у процесі один-два, тож реєстр обмежений.
 */
export function sharedInstancePool(apiUrls: readonly URL[]): InstancePool {
  const registry = globalThis as PoolRegistry;
  const pools = (registry[POOLS] ??= new Map<string, InstancePool>());
  const key = apiUrls.map((url) => url.origin).join(',');
  let pool = pools.get(key);
  if (!pool) {
    pool = new InstancePool(apiUrls.length);
    pools.set(key, pool);
  }
  return pool;
}
