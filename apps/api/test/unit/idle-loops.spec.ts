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
    expect(await settled(poller)).toBe(false);
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
});
