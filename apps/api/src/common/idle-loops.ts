/**
 * Паузи опитування паралельних циклів, що забирають роботу з черги (docs/architecture.md,
 * «Пробудження воркера»). Кожен цикл, не знайшовши роботи, спить свій інтервал опитування, як і без
 * підказок; підказка про нову готову роботу (`signal`, напр. `NOTIFY`) перериває сон одного циклу —
 * того, що заснув першим, — і він одразу перевіряє чергу. Решта циклів спить далі, тож підказка
 * коштує щонайбільше одне захоплення. Підказка, що прийшла, коли жоден цикл не спить, не губиться:
 * наступна пауза повертається одразу.
 *
 * Скасування `stop` перериває будь-яку паузу.
 */
export class IdleLoops {
  /** Пробудження циклів, що сплять, у порядку засинання. */
  private readonly sleeping: Array<() => void> = [];
  /** Підказка прийшла, коли жоден цикл не спав. */
  private pendingSignal = false;

  constructor(private readonly stop: AbortSignal) {}

  /** Пауза опитування `pollMs`, яку перериває підказка або скасування. */
  idle(pollMs: number): Promise<void> {
    if (this.stop.aborted) return Promise.resolve();
    if (this.pendingSignal) {
      this.pendingSignal = false;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => done(), pollMs);
      const done = () => {
        clearTimeout(timer);
        this.stop.removeEventListener('abort', done);
        const at = this.sleeping.indexOf(done);
        if (at >= 0) this.sleeping.splice(at, 1);
        resolve();
      };
      this.stop.addEventListener('abort', done, { once: true });
      this.sleeping.push(done);
    });
  }

  /** Підказка про нову готову роботу: будить один цикл, що спить (або запам'ятовується до паузи). */
  signal(): void {
    const next = this.sleeping.shift();
    if (next) next();
    else this.pendingSignal = true;
  }

  /** Скільки циклів зараз спить (для тестів і діагностики). */
  get sleepingCount(): number {
    return this.sleeping.length;
  }
}
