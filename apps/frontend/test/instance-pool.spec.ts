import { expect, test } from '@playwright/test';
import { InstancePool, sharedInstancePool } from '../lib/instance-pool';

/**
 * Порядок перебору інстансів API проксі фронтенду з керованим годинником. Перевірка `/ready`
 * підставна: тест сам вирішує, коли й з яким результатом вона завершиться.
 */
function pool(size: number) {
  const clock = { now: 1_000_000 };
  const probes: Array<{ index: number; answer: (ready: boolean) => void }> = [];
  const instances = new InstancePool(
    size,
    (index) => new Promise<boolean>((answer) => probes.push({ index, answer })),
    { baseCooldownMs: 30_000, maxCooldownMs: 120_000, now: () => clock.now },
  );
  return { instances, clock, probes };
}

test('starts at the instance that answered last and keeps the rest in rotation', () => {
  const { instances } = pool(3);
  expect(instances.order()).toEqual([0, 1, 2]);
  instances.succeeded(2, instances.begin());
  expect(instances.order()).toEqual([2, 0, 1]);
});

test('puts an instance that failed after every healthy one until its cooldown ends', () => {
  const { instances, clock } = pool(3);
  instances.failed(0, instances.begin());
  expect(instances.order()).toEqual([1, 2, 0]);
  instances.succeeded(2, instances.begin());
  expect(instances.order()).toEqual([2, 1, 0]);
  clock.now += 30_000;
  expect(instances.order()).toEqual([2, 0, 1]);
});

test('orders suspects by the end of their cooldown when none is healthy', () => {
  const { instances, clock } = pool(2);
  instances.failed(1, instances.begin());
  clock.now += 1_000;
  instances.failed(0, instances.begin());
  expect(instances.order()).toEqual([1, 0]);
});

/** Скільки інстанс 1 лишається підозрілим: поки він стоїть після інстансу 2 (preferred — 0). */
function suspectFor(instances: InstancePool, clock: { now: number }): number {
  let waited = 0;
  while (instances.order()[1] !== 1) {
    clock.now += 1_000;
    waited += 1_000;
  }
  return waited;
}

test('doubles the cooldown for each new failure up to the cap and resets it on an answer', () => {
  const { instances, clock } = pool(3);
  const cooldowns: number[] = [];
  for (let round = 0; round < 4; round++) {
    // Спроба після спливання cooldown, тобто нове свідчення, а не той самий інцидент.
    instances.failed(1, instances.begin());
    cooldowns.push(suspectFor(instances, clock));
  }
  expect(cooldowns).toEqual([30_000, 60_000, 120_000, 120_000]);
  instances.succeeded(1, instances.begin());
  instances.succeeded(0, instances.begin());
  instances.failed(1, instances.begin());
  expect(suspectFor(instances, clock)).toBe(30_000);
});

test('counts the requests of one incident once', () => {
  const { instances, clock } = pool(3);
  const inFlight = [instances.begin(), instances.begin(), instances.begin()];
  for (const attempt of inFlight) instances.failed(1, attempt);
  expect(suspectFor(instances, clock)).toBe(30_000);
});

test('ignores a late answer to a request sent before the instance hung', () => {
  const { instances } = pool(2);
  const early = instances.begin();
  instances.failed(0, instances.begin());
  instances.succeeded(0, early);
  expect(instances.order()).toEqual([1, 0]);
  instances.succeeded(0, instances.begin());
  expect(instances.order()).toEqual([0, 1]);
});

test('ignores a late failure of a request sent before a newer answer', () => {
  const { instances } = pool(2);
  const early = instances.begin();
  instances.succeeded(0, instances.begin());
  instances.failed(0, early);
  expect(instances.order()).toEqual([0, 1]);
});

test('marks an instance after a timeout only when it also fails /ready', async () => {
  const { instances, probes } = pool(2);
  instances.check(0, instances.begin());
  expect(probes.map((p) => p.index)).toEqual([0]);
  // Поки перевірка триває, порядок не змінюється.
  expect(instances.order()).toEqual([0, 1]);
  probes[0].answer(true);
  await instances.settled();
  expect(instances.order()).toEqual([0, 1]);

  instances.check(0, instances.begin());
  probes[1].answer(false);
  await instances.settled();
  expect(instances.order()).toEqual([1, 0]);
});

test('treats a probe that throws as a failed one', async () => {
  const instances = new InstancePool(2, () =>
    Promise.reject(new Error('probe broke')),
  );
  instances.check(0, instances.begin());
  await instances.settled();
  expect(instances.order()).toEqual([1, 0]);
});

test('runs one /ready check per instance at a time', async () => {
  const { instances, probes } = pool(2);
  for (let n = 0; n < 3; n++) instances.check(0, instances.begin());
  instances.check(1, instances.begin());
  expect(probes.map((p) => p.index)).toEqual([0, 1]);
  for (const probe of probes) probe.answer(true);
  await instances.settled();
  instances.check(0, instances.begin());
  expect(probes.map((p) => p.index)).toEqual([0, 1, 0]);
  probes[2].answer(true);
  await instances.settled();
});

test('does not check an instance for a request sent before a newer answer', async () => {
  const { instances, probes } = pool(2);
  const early = instances.begin();
  instances.succeeded(0, instances.begin());
  instances.check(0, early);
  expect(probes).toEqual([]);
  await instances.settled();
});

test('ignores a failed check when the instance answered a request sent during it', async () => {
  const { instances, probes } = pool(2);
  instances.check(0, instances.begin());
  instances.succeeded(0, instances.begin());
  probes[0].answer(false);
  await instances.settled();
  expect(instances.order()).toEqual([0, 1]);
});

test('shares one pool per API list within the process', () => {
  const urls = [new URL('http://api:3000'), new URL('http://api-2:3000')];
  const pool = sharedInstancePool(urls);
  expect(sharedInstancePool(urls.map((u) => new URL(u.href)))).toBe(pool);
  expect(sharedInstancePool([urls[0]])).not.toBe(pool);
});

test('rejects an empty instance list', () => {
  expect(() => new InstancePool(0, () => Promise.resolve(true))).toThrow();
});
