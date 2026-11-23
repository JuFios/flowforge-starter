/**
 * Вибір інстансу API для проксі фронтенду: HTTP (`lib/upstream.ts`) і WebSocket upgrade
 * (`lib/upgrade-proxy.ts`). Пасивний запобіжник із підтвердженням через `/ready`.
 *
 * - Першим пробується інстанс, що відповів останнім (`preferred`).
 * - Відмова з'єднання одразу робить інстанс підозрілим на cooldown: на неї не впливає зміст запиту.
 * - Таймаут чи обрив запиту, що вже пішов до API, самі інстанс не позначають. Повільна відповідь
 *   може бути наслідком самого запиту (великий знімок виконання) чи повільного клієнта, а це
 *   контролює тенант. Замість цього проксі перевіряє інстанс окремим `GET /ready`
 *   (`PROBE_TIMEOUT_MS`), не більше однієї перевірки на інстанс одночасно. Підозрілим інстанс
 *   стає, лише якщо `/ready` не відповів 2xx. Так порядок перебору не залежить від запитів
 *   тенанта. `/ready`, а не `/health`: інстанс, у якого вичерпано пул з'єднань із БД, на
 *   `/health` відповідає, але запитів не обслуговує.
 * - Підозрілий стоїть у порядку перебору після всіх справних, тому завислий API не перехоплює
 *   кожен наступний запит, поки поруч є справний. Але й не виключається зовсім: коли інші не
 *   відповідають, підозрілий усе одно пробується.
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
/**
 * Скільки чекати відповіді `/ready`. Довше за власний таймаут ping БД у `/ready` API (2 с): повільна
 * БД дає 503 від самого API, а не хибну позначку справного інстансу за таймаутом перевірки.
 */
export const PROBE_TIMEOUT_MS = 3_000;

/** Перевірка інстансу за індексом: true — він відповідає й готовий обслуговувати запити. */
export type InstanceProbe = (index: number) => Promise<boolean>;

export interface InstancePoolOptions {
  baseCooldownMs?: number;
  maxCooldownMs?: number;
  /** Годинник для cooldown (у тестах — керований). */
  now?: () => number;
}

/** `GET /ready` інстансу з власним таймаутом. Будь-яка помилка чи статус поза 2xx — false. */
export function readyProbe(
  apiUrls: readonly URL[],
  timeoutMs = PROBE_TIMEOUT_MS,
): InstanceProbe {
  return async (index) => {
    try {
      const res = await fetch(new URL('/ready', apiUrls[index]), {
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'manual',
        cache: 'no-store',
      });
      await res.body?.cancel().catch(() => undefined);
      return res.ok;
    } catch {
      return false;
    }
  };
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
  /** Перевірка `/ready`, що зараз триває, для кожного інстансу. */
  private readonly probing: Array<Promise<void> | undefined>;
  private readonly baseCooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly now: () => number;

  constructor(
    readonly size: number,
    private readonly probe: InstanceProbe,
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
    this.probing = new Array<Promise<void> | undefined>(size).fill(undefined);
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

  /** Номер спроби; передається в `succeeded`, `failed` чи `check` з її результатом. */
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
   * Відмова, на яку зміст запиту не впливає (з'єднання не встановилося), або непройдена перевірка
   * `/ready`. Спроба, почата до останньої позначки, — той самий інцидент; почата до новішої
   * відповіді — застаріле свідчення.
   */
  failed(index: number, attempt: number): void {
    if (this.stale(index, attempt)) return;
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

  /**
   * Запит, що міг дійти до API, не отримав відповіді (таймаут чи обрив). Причиною може бути сам
   * запит, тож інстанс перевіряється окремим `/ready`. Позначка — лише за непройденою перевіркою;
   * її свідчення — сама перевірка: інстанс, що відповів на новіший запит, вона вже не позначить.
   */
  check(index: number, attempt: number): void {
    if (this.stale(index, attempt) || this.probing[index]) return;
    const probeAttempt = this.begin();
    const probing = this.probe(index)
      .catch(() => false)
      .then((ready) => {
        if (!ready) this.failed(index, probeAttempt);
      })
      .finally(() => {
        this.probing[index] = undefined;
      });
    this.probing[index] = probing;
  }

  /** Завершення всіх перевірок `/ready`, що зараз тривають (для тестів і діагностики). */
  async settled(): Promise<void> {
    await Promise.all(this.probing);
  }

  private stale(index: number, attempt: number): boolean {
    return attempt <= this.markedAt[index] || attempt < this.answeredAt[index];
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
    pool = new InstancePool(apiUrls.length, readyProbe(apiUrls));
    pools.set(key, pool);
  }
  return pool;
}
