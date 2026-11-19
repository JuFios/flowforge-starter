import { DataSource } from 'typeorm';
import {
  problems,
  runCount,
  withBacklog,
  workerClaimP95,
  readLoadResponse,
} from '../../scripts/load-fairness';

const phase = {
  succeeded: 30,
  seconds: 8,
  waitP95: 0.2,
  durationP95: 0.6,
  aLeftAtEnd: 18000,
};
const valid = {
  alone: phase,
  loaded: phase,
  aPerSecond: 10,
  aDuringB: 20,
  claimP95Ms: 10,
};
describe('fairness load evidence', () => {
  it.each(['0', 'bad', '-1', '1.5', 'Infinity', '99999'])(
    'rejects an invalid run count %s',
    (raw) => {
      expect(() => runCount(raw)).toThrow(/LOAD_RUNS/);
    },
  );
  it('rejects negative bucket deltas and a non-finite claim percentile', () => {
    const buckets = (small: number, total: number) =>
      new Map([
        [0.001, small],
        [Infinity, total],
      ]);
    const before = new Map([
      ['worker-a/start1', buckets(0, 1000)],
      ['worker-b/start1', buckets(10, 10)],
    ]);
    const reset = new Map(before).set('worker-a/start1', buckets(0, 10));
    expect(workerClaimP95(before, reset)).toBeUndefined();
    const restarted = new Map(before);
    restarted.delete('worker-a/start1');
    restarted.set('worker-a/start2', buckets(1000, 2000));
    expect(workerClaimP95(before, restarted)).toBeUndefined();
    expect(
      workerClaimP95(
        before,
        new Map(before).set('worker-a/start1', buckets(20, 1020)),
      ),
    ).toBe(1);
    expect(problems({ ...valid, claimP95Ms: NaN })).not.toEqual([]);
  });
  it('bounds the bytes actually read from the API', async () => {
    const res = new Response(JSON.stringify({ field: 'x'.repeat(130000) }));
    await expect(readLoadResponse(res)).rejects.toThrow(/large|limit/);
  });
  it('requires complete measurements within the deadline for both phases', () => {
    expect(problems(valid)).toEqual([]);
    for (const field of ['alone', 'loaded'] as const) {
      for (const change of [{ succeeded: 1 }, { seconds: 121 }]) {
        expect(
          problems({ ...valid, [field]: { ...phase, ...change } }),
        ).not.toEqual([]);
      }
    }
  });
  it('requires the backlog tenant to complete work during the loaded phase', () => {
    expect(problems({ ...valid, aDuringB: 0 } as typeof valid)).not.toEqual([]);
  });
  it('cleans only the current backlog after a failed measurement', async () => {
    const sql = jest.fn().mockResolvedValue([{ running: 0, pending: 0 }]);
    const tenant = { id: 'load-a', workflow: 'wf-a', auth: {} };
    await expect(
      withBacklog({ query: sql } as unknown as DataSource, tenant, () =>
        Promise.reject(new Error('metric failed')),
      ),
    ).rejects.toThrow('metric failed');
    expect(sql.mock.calls as unknown[][]).toEqual(
      expect.arrayContaining([
        [expect.stringMatching(/DELETE FROM jobs/i), [tenant.id]],
      ]),
    );
  });
});
