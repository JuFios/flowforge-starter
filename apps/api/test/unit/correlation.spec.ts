import {
  getCorrelationId,
  getCorrelationSource,
  normalizeCorrelationId,
  runWithCorrelationId,
} from '../../src/observability/correlation';

describe('correlation id', () => {
  it('accepts safe ids and rejects unsafe ones', () => {
    expect(normalizeCorrelationId('abc-123_X.y:z')).toBe('abc-123_X.y:z');
    expect(normalizeCorrelationId(['first', 'second'])).toBe('first');
    expect(normalizeCorrelationId('')).toBeUndefined();
    expect(normalizeCorrelationId('a'.repeat(129))).toBeUndefined();
    expect(normalizeCorrelationId('line\nbreak')).toBeUndefined();
    expect(normalizeCorrelationId('{"json":1}')).toBeUndefined();
    expect(normalizeCorrelationId(undefined)).toBeUndefined();
  });

  it('is visible across awaits inside the context and absent outside', async () => {
    expect(getCorrelationId()).toBeUndefined();
    await runWithCorrelationId('ctx-1', 'job', async () => {
      await new Promise((r) => setTimeout(r, 5));
      expect(getCorrelationId()).toBe('ctx-1');
      expect(getCorrelationSource()).toBe('job');
    });
    expect(getCorrelationId()).toBeUndefined();
  });

  it('keeps concurrent contexts apart', async () => {
    const seen = await Promise.all(
      ['a', 'b', 'c'].map((id, i) =>
        runWithCorrelationId(id, 'job', async () => {
          await new Promise((r) => setTimeout(r, 10 - i * 3));
          return getCorrelationId();
        }),
      ),
    );
    expect(seen).toEqual(['a', 'b', 'c']);
  });
});
