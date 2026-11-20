/** Чекає, поки `check` поверне істину, опитуючи кожні `intervalMs`; інакше — помилка з `what`. */
export async function waitFor(
  what: string,
  check: () => Promise<boolean> | boolean,
  { timeoutMs = 15_000, intervalMs = 50 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(intervalMs);
  }
}

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
