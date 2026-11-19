export interface ClaimRecord {
  tenant: string;
  requestedAt: number;
  claimedAt: number;
  finishedAt: number;
}

/** Перевірка верхньої межі в підтверджених інтервалах готовності. */
export function assertClaimFairness(
  journal: ClaimRecord[],
  ready: string[],
  C: number,
): void {
  const K = ready.length;
  const claims = [...journal].sort((x, y) => x.claimedAt - y.claimedAt);
  expect(claims.length).toBeGreaterThanOrEqual(400);
  const end = Math.max(...claims.map((c) => c.finishedAt)) + 1;
  let interiorWindows = 0;
  for (const tenant of ready) {
    let since = 0;
    const check = (until: number) => {
      const others = claims.filter(
        (c) =>
          c.tenant !== tenant && c.claimedAt > since && c.claimedAt < until,
      );
      expect(others.length).toBeLessThanOrEqual(K - 1 + C);
    };
    for (const claim of claims.filter((c) => c.tenant === tenant)) {
      if (claim.requestedAt > since) {
        check(claim.requestedAt);
        if (since > 0) interiorWindows++;
      }
      since = claim.finishedAt;
    }
    check(end);
  }
  expect(interiorWindows).toBeGreaterThan(300);
}
