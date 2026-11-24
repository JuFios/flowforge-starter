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

describe('idle loops: polling pauses that a ready-work hint can cut short', () => {
  beforeEach(() => jest.useFakeTimers({ doNotFake: ['setImmediate'] }));
  afterEach(() => jest.useRealTimers());

  it('lets every loop sleep its own poll interval, as without hints', async () => {
    const loops = new IdleLoops(new AbortController().signal);
    const short = loops.idle(300);
    const long = loops.idle(700);
    expect(loops.sleepingCount).toBe(2);
    jest.advanceTimersByTime(300);
    expect(await settled(short)).toBe(true);
    expect(await settled(long)).toBe(false);
    jest.advanceTimersByTime(400);
    expect(await settled(long)).toBe(true);
    expect(loops.sleepingCount).toBe(0);
  });

  it('a hint wakes only the loop that fell asleep first, the others keep sleeping', async () => {
    const loops = new IdleLoops(new AbortController().signal);
    const first = loops.idle(60_000);
    const second = loops.idle(60_000);
    const third = loops.idle(60_000);
    loops.signal();
    expect(await settled(first)).toBe(true);
    expect(await settled(second)).toBe(false);
    expect(await settled(third)).toBe(false);
    expect(loops.sleepingCount).toBe(2);
  });

  it('keeps a hint that arrived while no loop slept for the next pause, once', async () => {
    const loops = new IdleLoops(new AbortController().signal);
    loops.signal();
    loops.signal();
    expect(await settled(loops.idle(60_000))).toBe(true);
    expect(await settled(loops.idle(60_000))).toBe(false);
  });

  it('stopping releases every sleeping loop and later pauses return at once', async () => {
    const stop = new AbortController();
    const loops = new IdleLoops(stop.signal);
    const waits = [loops.idle(60_000), loops.idle(60_000), loops.idle(60_000)];
    stop.abort();
    for (const wait of waits) expect(await settled(wait)).toBe(true);
    expect(loops.sleepingCount).toBe(0);
    expect(await settled(loops.idle(60_000))).toBe(true);
  });
});
