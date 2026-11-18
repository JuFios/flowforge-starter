import { retryDelayMs } from '../../src/engine/job-queue.service';
import { parseRetryAfter } from '../../src/engine/retry-after';

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-11-18T12:00:00Z');

  it.each([
    ['0', 0],
    ['2', 2_000],
    [' 120 ', 120_000],
    ['Wed, 18 Nov 2026 12:00:30 GMT', 30_000],
    ['Wed, 18 Nov 2026 11:59:00 GMT', 0],
  ])('reads %p as %i ms', (header, ms) => {
    expect(parseRetryAfter(header, now)).toBe(ms);
  });

  it.each([null, '', '-1', '1.5', 'soon', '2026-11-18T12:00:30Z', '1e3'])(
    'ignores %p',
    (header) => {
      expect(parseRetryAfter(header, now)).toBeUndefined();
    },
  );
});

describe('retryDelayMs', () => {
  const options = { baseMs: 100, maxMs: 10_000, random: () => 0.5 };

  it('is the ordinary backoff without a hint from the receiver', () => {
    // base + 0.5 · (min(max, base·2^1) − base) = 150
    expect(retryDelayMs(1, options)).toBe(150);
  });

  it('waits as long as the receiver asks when that is longer than the backoff', () => {
    expect(retryDelayMs(1, options, 3_000)).toBe(3_000);
  });

  it('keeps the backoff when the receiver asks for less (including 0)', () => {
    expect(retryDelayMs(1, options, 0)).toBe(150);
    expect(retryDelayMs(1, options, 10)).toBe(150);
  });

  it('never exceeds the configured cap', () => {
    expect(retryDelayMs(1, options, 86_400_000)).toBe(10_000);
  });
});
