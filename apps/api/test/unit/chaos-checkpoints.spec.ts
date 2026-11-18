import {
  EXECUTIONS,
  STEPS,
  guaranteeProblems,
  replayedCheckpoints,
} from '../../scripts/chaos-common';

describe('chaos checkpoint evidence', () => {
  const charge = {
    id: 'r1',
    stepId: 'charge',
    idempotencyKey: 'key1',
    attempts: 1,
    calls: 1,
    callKey: 'key1',
    finishedAt: '2026-11-18T10:00Z',
  };
  const observed = new Map([[charge.id, charge]]);
  it('detects another HTTP call even if the receiver deduplicates and the step row is unchanged', () => {
    expect(replayedCheckpoints(observed, [charge], { key1: 2 })).toBe(1);
  });
  it('detects a restarted or missing completed step', () => {
    expect(
      replayedCheckpoints(observed, [{ ...charge, attempts: 2 }], { key1: 1 }),
    ).toBe(1);
    expect(replayedCheckpoints(observed, [], { key1: 1 })).toBe(1);
  });
  it('fails the report for a replay even with all executions and distinct effects present', () => {
    const outcome = {
      succeeded: EXECUTIONS,
      failed: 0,
      stepRows: EXECUTIONS * STEPS,
      repeatedSteps: 1,
      repeatedHttp: 1,
      observedSteps: 1,
      observedHttp: 1,
      changedCheckpoints: 1,
      reclaimed: 1,
      dead: 0,
      sink: {
        requests: EXECUTIONS + 1,
        effects: EXECUTIONS,
        repeatedKeys: 1,
        missingKey: 0,
      },
    };
    expect(guaranteeProblems(outcome)).toHaveLength(1);
    expect(guaranteeProblems({ ...outcome, changedCheckpoints: 0 })).toEqual(
      [],
    );
  });
  it('allows multiple attempts of an unfinished step', () => {
    expect(
      replayedCheckpoints(
        observed,
        [charge, { ...charge, id: 'r2', idempotencyKey: 'key2', attempts: 2 }],
        { key1: 1, key2: 2 },
      ),
    ).toBe(0);
  });
});
