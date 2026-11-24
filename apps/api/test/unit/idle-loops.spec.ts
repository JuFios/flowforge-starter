import { IdleLoops } from '../../src/common/idle-loops';

/** Стан промісу без очікування: чи він уже виконався. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  return done;
}

describe('idle loops: one polls, the rest wait for work', () => {
  beforeEach(() => jest.useFakeTimers({ doNotFake: ['setImmediate'] }));
  afterEach(() => jest.useRealTimers());

  it('lets exactly one idle loop poll and parks the others without a timer', async () => {
    const loops = new IdleLoops(new AbortController().signal);
    const waits = Array.from({ length: 4 }, () => loops.idle(1_000));
    expect(loops.parkedCount).toBe(3);
    jest.advanceTimersByTime(1_000);
    expect(await settled(waits[0])).toBe(true);
    for (const wait of waits.slice(1)) expect(await settled(wait)).toBe(false);
  });

  it('wakes one parked loop per unit of work, so loops wake in a chain while work lasts', async () => {
    const loops = new IdleLoops(new AbortController().signal);
    const poller = loops.idle(60_000);
    const parked = [loops.idle(60_000), loops.idle(60_000)];
    loops.worked();
    expect(await settled(parked[0])).toBe(true);
    expect(await settled(parked[1])).toBe(false);
    loops.worked();
    expect(await settled(parked[1])).toBe(true);
    // Кожен цикл, що паркувався, будив чергового перевірити чергу заново.
    expect(await settled(poller)).toBe(true);
    // Нікого не розбуджено зайвий раз: без запаркованих worked нічого не робить.
    loops.worked();
    expect(loops.parkedCount).toBe(0);
  });

  it('hands the polling role to the next loop that goes idle once the poller leaves', async () => {
    const loops = new IdleLoops(new AbortController().signal);
    const poller = loops.idle(1_000);
    const parked = loops.idle(1_000);
    jest.advanceTimersByTime(1_000);
    await settled(poller);
    // Колишній черговий отримав роботу й будить запаркований цикл; той, не знайшовши роботи,
    // стає черговим, а не паркується без опитувача.
    loops.worked();
    expect(await settled(parked)).toBe(true);
    const next = loops.idle(1_000);
    expect(loops.parkedCount).toBe(0);
    jest.advanceTimersByTime(1_000);
    expect(await settled(next)).toBe(true);
  });

  it('a signal wakes the poller at once, and a signal with nobody polling is kept for the next idle', async () => {
    const loops = new IdleLoops(new AbortController().signal);
    const poller = loops.idle(60_000);
    loops.signal();
    expect(await settled(poller)).toBe(true);

    loops.signal();
    expect(await settled(loops.idle(60_000))).toBe(true);
    // Сигнал спожито: наступний простій знову чекає.
    expect(await settled(loops.idle(60_000))).toBe(false);
  });

  it('a signal while the poller is busy wakes a parked loop instead', async () => {
    const loops = new IdleLoops(new AbortController().signal);
    const poller = loops.idle(1_000);
    const parked = loops.idle(1_000);
    jest.advanceTimersByTime(1_000);
    await settled(poller);
    loops.signal();
    expect(await settled(parked)).toBe(true);
  });

  it('stopping releases every waiting loop and later idles return at once', async () => {
    const stop = new AbortController();
    const loops = new IdleLoops(stop.signal);
    const waits = [loops.idle(60_000), loops.idle(60_000), loops.idle(60_000)];
    stop.abort();
    for (const wait of waits) expect(await settled(wait)).toBe(true);
    expect(loops.parkedCount).toBe(0);
    expect(await settled(loops.idle(60_000))).toBe(true);
  });

  it('the poller sleeps only until the next delayed work is due, and polls as usual without one', async () => {
    const loops = new IdleLoops(new AbortController().signal);
    const soon = loops.idle(60_000, () => Promise.resolve(200));
    await settled(soon);
    jest.advanceTimersByTime(210);
    expect(await settled(soon)).toBe(true);

    for (const due of [
      () => Promise.resolve(null),
      () => Promise.reject(new Error('db down')),
      () => {
        throw new Error('not a promise');
      },
    ]) {
      const usual = loops.idle(1_000, due as () => Promise<number | null>);
      await settled(usual);
      jest.advanceTimersByTime(500);
      expect(await settled(usual)).toBe(false);
      jest.advanceTimersByTime(500);
      expect(await settled(usual)).toBe(true);
    }
  });

  it('a signal that arrives while the poller looks the due time up wakes it at once', async () => {
    const loops = new IdleLoops(new AbortController().signal);
    let answer!: (ms: number | null) => void;
    const poller = loops.idle(
      60_000,
      () => new Promise<number | null>((resolve) => (answer = resolve)),
    );
    await settled(poller);
    loops.signal();
    answer(30_000);
    expect(await settled(poller)).toBe(true);
  });

  it('a loop going idle while another polls makes the poller look the queue and due time up again', async () => {
    const loops = new IdleLoops(new AbortController().signal);
    const lookups: number[] = [];
    const poller = loops.idle(60_000, () => {
      lookups.push(Date.now());
      return Promise.resolve(null);
    });
    await settled(poller);
    expect(lookups).toHaveLength(1);
    // Цикл, що щойно відклав роботу на майбутнє, паркується й будить чергового.
    const parked = loops.idle(60_000);
    expect(await settled(poller)).toBe(true);
    expect(await settled(parked)).toBe(false);
  });
});
