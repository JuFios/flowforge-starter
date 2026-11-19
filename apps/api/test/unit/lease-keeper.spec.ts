import { Logger } from '@nestjs/common';
import { JobQueueService } from '../../src/engine/job-queue.service';
import { LeaseKeeper } from '../../src/engine/lease-keeper';
import { Job } from '../../src/entities';

const LEASE_MS = 3_000;
const job = { id: 'job-1', executionId: 'exec-1', lockToken: 't' } as Job;

function keeperWith(heartbeat: jest.Mock): LeaseKeeper {
  return new LeaseKeeper(
    { heartbeat } as unknown as JobQueueService,
    job,
    LEASE_MS,
    performance.now(),
  ).start();
}

describe('LeaseKeeper', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('renews the lease every third of its duration while the job runs', async () => {
    const heartbeat = jest.fn().mockResolvedValue(true);
    const keeper = keeperWith(heartbeat);

    await jest.advanceTimersByTimeAsync(LEASE_MS * 3);
    keeper.stop();

    expect(heartbeat).toHaveBeenCalledTimes(9);
    expect(keeper.signal.aborted).toBe(false);
  });

  // Повільна БД: кожне продовження триває чверть lease. Наступне мусить стартувати за розкладом
  // від старту попереднього, а не через третину lease після його завершення — інакше дві повільні
  // відповіді поспіль з'їдають запас дедлайну, і воркер кидає задачу з чинним lease.
  it('keeps the lease when every renewal takes a quarter of it', async () => {
    const heartbeat = jest.fn(
      () =>
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(true), LEASE_MS / 4),
        ),
    );
    const keeper = keeperWith(heartbeat);

    await jest.advanceTimersByTimeAsync(LEASE_MS * 5);
    keeper.stop();

    expect(keeper.signal.aborted).toBe(false);
    expect(heartbeat.mock.calls.length).toBeGreaterThanOrEqual(14);
  });

  it('counts time spent waiting for claim toward both the first renewal and the safety deadline', async () => {
    const sent = performance.now();
    await jest.advanceTimersByTimeAsync(1500);
    const heartbeat = jest.fn(() => new Promise<boolean>(() => undefined));
    const keeper = new LeaseKeeper(
      { heartbeat } as unknown as JobQueueService,
      job,
      LEASE_MS,
      sent,
    ).start();
    await jest.advanceTimersByTimeAsync(1);
    expect(heartbeat).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(898);
    expect(keeper.signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(keeper.signal.aborted).toBe(true);
    keeper.stop();
  });

  it('leaves no timer when a pending renewal succeeds after stop', async () => {
    let complete!: (ok: boolean) => void;
    const keeper = keeperWith(
      jest.fn(
        () =>
          new Promise<boolean>((resolve) => {
            complete = resolve;
          }),
      ),
    );
    await jest.advanceTimersByTimeAsync(LEASE_MS / 3);
    keeper.stop();
    complete(true);
    await Promise.resolve();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('aborts at once when the lease was taken over', async () => {
    const heartbeat = jest.fn().mockResolvedValue(false);
    const keeper = keeperWith(heartbeat);

    await jest.advanceTimersByTimeAsync(LEASE_MS / 3);

    expect(keeper.signal.aborted).toBe(true);
    await jest.advanceTimersByTimeAsync(LEASE_MS * 3);
    expect(heartbeat).toHaveBeenCalledTimes(1);
  });

  it('keeps working through a short database outage', async () => {
    const heartbeat = jest
      .fn()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValue(true);
    const keeper = keeperWith(heartbeat);

    await jest.advanceTimersByTimeAsync(LEASE_MS * 2);
    keeper.stop();

    expect(keeper.signal.aborted).toBe(false);
  });

  it('gives the job up before the lease runs out when renewals keep failing', async () => {
    const heartbeat = jest.fn().mockRejectedValue(new Error('db down'));
    const keeper = keeperWith(heartbeat);

    // Друга невдала спроба — на 2/3 lease: запас 20% ще є, працюємо далі.
    await jest.advanceTimersByTimeAsync((LEASE_MS * 2) / 3);
    expect(keeper.signal.aborted).toBe(false);
    // Третя — на межі lease: інший воркер уже може забрати задачу.
    await jest.advanceTimersByTimeAsync(LEASE_MS / 3);
    expect(keeper.signal.aborted).toBe(true);
    keeper.stop();
  });

  it('gives the job up before the lease runs out even when a renewal hangs', async () => {
    // Запит до БД завис (до query_timeout, що довший за lease): відповіді немає взагалі.
    const heartbeat = jest.fn(() => new Promise<boolean>(() => undefined));
    const keeper = keeperWith(heartbeat);

    // Запас 20% lease: до 80% задача ще наша.
    await jest.advanceTimersByTimeAsync(LEASE_MS * 0.8 - 10);
    expect(keeper.signal.aborted).toBe(false);
    // Далі інший воркер може отримати її від reaper-а — крок треба зупинити, не чекаючи запиту.
    await jest.advanceTimersByTimeAsync(20);
    expect(keeper.signal.aborted).toBe(true);
    expect(heartbeat).toHaveBeenCalledTimes(1);
    keeper.stop();
  });

  it('moves the deadline forward after every successful renewal', async () => {
    let calls = 0;
    // Перші два продовження вдалі, третє зависає.
    const heartbeat = jest.fn(() =>
      ++calls <= 2
        ? Promise.resolve(true)
        : new Promise<boolean>(() => undefined),
    );
    const keeper = keeperWith(heartbeat);

    // Друге продовження — на 2/3 lease; дедлайн тепер 2/3 + 0,8 lease.
    await jest.advanceTimersByTimeAsync(LEASE_MS * (2 / 3 + 0.8) - 10);
    expect(keeper.signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(20);
    expect(keeper.signal.aborted).toBe(true);
    keeper.stop();
  });
});
