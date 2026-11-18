import {
  BackoffOptions,
  retryDelayMs,
  backoffMs as backoff,
} from '../../src/engine/job-queue.service';

describe('backoffMs', () => {
  const opts = (random: () => number): BackoffOptions => ({
    baseMs: 1_000,
    maxMs: 60_000,
    random,
  });

  it('spreads retries of the same attempt instead of firing them at the same moment', () => {
    const low = backoff(
      3,
      opts(() => 0),
    );
    const high = backoff(
      3,
      opts(() => 0.999),
    );
    expect(low).not.toBe(high);
  });

  it('uses the same Retry-After when it dominates the jittered backoff', () => {
    for (const r of [0, 0.5, 0.999])
      expect(
        retryDelayMs(
          1,
          opts(() => r),
          3000,
        ),
      ).toBe(3000);
  });

  it('stays within base..base·2^attempt for every random value', () => {
    for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
      const delay = backoff(
        3,
        opts(() => r),
      );
      expect(delay).toBeGreaterThanOrEqual(1_000);
      expect(delay).toBeLessThanOrEqual(8_000);
    }
  });

  it('grows the upper bound exponentially with the attempt number', () => {
    const top = (attempt: number) =>
      backoff(
        attempt,
        opts(() => 0.999),
      );
    expect(top(2)).toBeLessThan(top(3));
    expect(top(3)).toBeLessThan(top(4));
  });

  it('never exceeds the cap, even after many attempts', () => {
    for (const attempt of [10, 40, 1_100])
      expect(
        backoff(
          attempt,
          opts(() => 0.999),
        ),
      ).toBeLessThanOrEqual(60_000);
  });
});
