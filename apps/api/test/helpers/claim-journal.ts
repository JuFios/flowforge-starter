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
  let windows = 0;
  for (const previous of claims) {
    const next = claims.find(
      (c) => c.tenant === previous.tenant && c.claimedAt > previous.claimedAt,
    );
    if (!next || next.requestedAt <= previous.finishedAt) continue;
    windows++;
    // Рахуємо завершені захоплення в підтвердженому вікні готовності:
    // після COMMIT завершення і до початку наступного захоплення тенанта.
    const others = claims.filter(
      (c) =>
        c.tenant !== previous.tenant &&
        c.claimedAt > previous.finishedAt &&
        c.claimedAt < next.requestedAt,
    );
    expect(others.length).toBeLessThanOrEqual(K - 1 + C);
  }
  expect(windows).toBeGreaterThan(300);
}
