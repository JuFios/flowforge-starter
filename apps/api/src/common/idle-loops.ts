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
   * Роботи немає: чекає до наступної спроби. Черговий — `pollMs` або до сигналу; інші — доки їх
   * не розбудить цикл, що отримав роботу, або доки не звільниться роль чергового.
   */
  async idle(pollMs: number): Promise<void> {
    if (this.stop.aborted) return;
    if (this.pendingSignal) {
      this.pendingSignal = false;
      return;
    }
    if (this.polling) {
      await this.wait((resolve) => this.parked.push(resolve));
      return;
    }
    this.polling = true;
    try {
      await this.wait((resolve) => {
        this.wakePolling = resolve;
        setTimeout(resolve, pollMs).unref();
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
