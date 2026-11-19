import { assertClaimFairness } from '../helpers/claim-journal';

describe('claim fairness observation window', () => {
  const ready = Array.from({ length: 8 }, (_, i) => String(i));
  const journal = (ids: readonly string[]) =>
    ids.map((tenant, i) => ({
      tenant,
      requestedAt: 3 * i + 1,
      claimedAt: 3 * i + 2,
      finishedAt: 3 * i + 3,
    }));
  const sequence = (n: number, k: number) =>
    Array.from({ length: n }, (_, i) => ready[i % k]);
  it.each([
    ['unserved tenant', sequence(400, 7)],
    ['unbounded initial wait', [...sequence(20, 7), ...sequence(380, 8)]],
    ['unbounded final wait', [...sequence(380, 8), ...sequence(20, 7)]],
  ] as const)('rejects %s', (_name, ids) => {
    expect(() => assertClaimFairness(journal(ids), ready, 4)).toThrow();
  });
  it('accepts a bounded rotation', () => {
    assertClaimFairness(journal(sequence(400, 8)), ready, 4);
  });
});
