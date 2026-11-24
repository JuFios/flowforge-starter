/**
 * Простій паралельних циклів, що забирають роботу з черги (docs/architecture.md, «Черговий цикл і
 * пробудження»). Коли роботи немає, опитує лише один цикл — черговий — з тим самим інтервалом, що й
 * раніше; решта чекають без звернень до БД. Цикл, що отримав роботу, будить одного з тих, хто чекає
 * (`worked`): той перевіряє чергу й або бере наступну роботу (і будить ще одного), або стає черговим.
 * Тож поки є робота, цикли прокидаються ланцюгом, а в простої БД опитує один цикл на процес.
 *
 * Сигнал (`signal`, напр. `NOTIFY` про нову готову роботу) будить чергового одразу. Сигнал, що
 * прийшов, коли ніхто не чекає, не губиться: наступний простій повертається без паузи.
 *
 * Скасування `stop` перериває будь-яке очікування.
 */
/** Запас після строку відкладеної роботи: строк рахує годинник БД, а захоплення — теж він. */
const DUE_SLACK_MS = 5;

export class IdleLoops {
  /** Чи є черговий (цикл, що опитує з інтервалом). */
  private polling = false;
  /** Пробудження чергового раніше інтервалу. */
  private wakePolling?: () => void;
  /** Цикли, що чекають без опитування, у порядку надходження. */
  private readonly parked: Array<() => void> = [];
  /** Сигнал прийшов, коли черговий не чекав. */
  private pendingSignal = false;

  constructor(private readonly stop: AbortSignal) {}

  /**
   * Роботи немає: чекає до наступної спроби. Черговий — `pollMs` (або менше: до строку найближчої
   * відкладеної роботи, який повертає `nextDueMs`) чи до сигналу; інші — доки їх не розбудить цикл,
   * що отримав роботу, або доки не звільниться роль чергового.
   *
   * `nextDueMs` викликає лише черговий; null — відкладеної роботи немає. Помилку викликач має
   * обробити сам (залогувати й повернути null); якщо вона все ж дійде сюди, черговий чекає `pollMs`.
   */
  async idle(
    pollMs: number,
    nextDueMs?: () => Promise<number | null>,
  ): Promise<void> {
    if (this.stop.aborted) return;
    if (this.pendingSignal) {
      this.pendingSignal = false;
      return;
    }
    if (this.polling) {
      // Цикл щойно працював і міг відкласти роботу на майбутнє (пауза `delay`, повтор із backoff),
      // про яку черговий, що вже спить, не знає: черговий перевіряє чергу й строк заново.
      this.nudgePoller();
      await this.wait((resolve) => this.parked.push(resolve));
      return;
    }
    this.polling = true;
    try {
      let waitMs = pollMs;
      if (nextDueMs) {
        const due = await Promise.resolve()
          .then(nextDueMs)
          .catch(() => null);
        if (due !== null && due > 0)
          waitMs = Math.min(waitMs, due + DUE_SLACK_MS);
      }
      // Сигнал, що прийшов, поки черговий питав строк, не губиться.
      if (this.pendingSignal || this.stop.aborted) {
        this.pendingSignal = false;
        return;
      }
      await this.wait((resolve) => {
        this.wakePolling = resolve;
        setTimeout(resolve, waitMs).unref();
      });
    } finally {
      this.wakePolling = undefined;
      this.polling = false;
    }
  }

  /** Цикл отримав роботу: будить одного з тих, хто чекає, — він перевірить, чи є ще. */
  worked(): void {
    this.parked.shift()?.();
  }

  /**
   * Черговий перевіряє чергу й строк заново: будиться, якщо спить, а якщо саме питає строк —
   * повернеться без сну.
   */
  private nudgePoller(): void {
    if (this.wakePolling) this.wakePolling();
    else if (this.polling) this.pendingSignal = true;
  }

  /** Зовнішня підказка про нову роботу: будить чергового (або запам'ятовується до простою). */
  signal(): void {
    if (this.wakePolling) this.wakePolling();
    else if (this.polling || this.parked.length === 0)
      this.pendingSignal = true;
    else this.worked();
  }

  /** Скільки циклів чекають без опитування (для тестів і діагностики). */
  get parkedCount(): number {
    return this.parked.length;
  }

  private wait(register: (resolve: () => void) => void): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.stop.aborted) return resolve();
      const done = () => {
        this.stop.removeEventListener('abort', done);
        const at = this.parked.indexOf(done);
        if (at >= 0) this.parked.splice(at, 1);
        resolve();
      };
      this.stop.addEventListener('abort', done, { once: true });
      register(done);
    });
  }
}
