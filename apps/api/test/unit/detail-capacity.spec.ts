import { HttpStatus } from '@nestjs/common';
import { DetailCapacity } from '../../src/executions/execution-reader.service';
import { DetailInProgressException } from '../../src/limits/limit-exceptions';

const status = (fn: () => unknown): number | undefined => {
  try {
    fn();
    return undefined;
  } catch (err) {
    return (err as { getStatus(): number }).getStatus();
  }
};

describe('DetailCapacity', () => {
  it('refuses a second snapshot of the same tenant with 429 and keeps room for others', () => {
    const pool = new DetailCapacity({
      maxConcurrent: 2,
      maxPerTenant: 1,
      diskBytes: 100,
    });
    pool.acquire('a');
    expect(() => pool.acquire('a')).toThrow(DetailInProgressException);
    expect(() => pool.acquire('b')).not.toThrow();
  });

  it('refuses a new snapshot with 503 when the pool is full and accepts it after a release', () => {
    const pool = new DetailCapacity({
      maxConcurrent: 2,
      maxPerTenant: 1,
      diskBytes: 100,
    });
    const a = pool.acquire('a');
    pool.acquire('b');
    expect(status(() => pool.acquire('c'))).toBe(
      HttpStatus.SERVICE_UNAVAILABLE,
    );
    a.release();
    expect(() => pool.acquire('c')).not.toThrow();
  });

  it('bounds the disk reserved by all snapshots and returns the bytes on release', () => {
    const pool = new DetailCapacity({
      maxConcurrent: 4,
      maxPerTenant: 1,
      diskBytes: 100,
    });
    const a = pool.acquire('a');
    a.reserve(60);
    const b = pool.acquire('b');
    expect(status(() => b.reserve(41))).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    b.reserve(40);
    expect(status(() => pool.acquire('c'))).toBe(
      HttpStatus.SERVICE_UNAVAILABLE,
    );
    a.release();
    const c = pool.acquire('c');
    expect(() => c.reserve(60)).not.toThrow();
  });

  it('releases each lease once, whatever the number of calls', () => {
    const pool = new DetailCapacity({
      maxConcurrent: 2,
      maxPerTenant: 1,
      diskBytes: 100,
    });
    const a = pool.acquire('a');
    a.reserve(10);
    a.release();
    a.release();
    expect(status(() => a.reserve(1))).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    // Подвійне звільнення не дало зайвого місця: пул знову вміщує рівно два знімки.
    pool.acquire('a');
    pool.acquire('b');
    expect(status(() => pool.acquire('c'))).toBe(
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  });
});
