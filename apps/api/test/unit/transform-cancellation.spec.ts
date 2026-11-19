import children from 'node:child_process';
import { once } from 'node:events';
import { isolatedTransform } from '../../src/engine/isolated-transform';

describe('transform cancellation', () => {
  it('terminates an unresponsive evaluator when the overall deadline expires', async () => {
    const spy = jest.spyOn(children, 'spawn');
    const task = isolatedTransform('1+1', 'jsonata-v1', {
      input: {},
      steps: {},
    });
    const child = spy.mock.results[0].value as children.ChildProcess;
    try {
      await once(child, 'spawn');
      child.kill('SIGSTOP');
      await expect(task).rejects.toMatchObject({ retryable: false });
      expect(child.signalCode).toBe('SIGKILL');
    } finally {
      child.kill('SIGKILL');
      spy.mockRestore();
    }
  });
  it('reaps the stopped child before releasing the step and can evaluate the next expression', async () => {
    const spy = jest.spyOn(children, 'spawn');
    const abort = new AbortController();
    const ctx = { input: { value: 4 }, steps: {} };
    const task = isolatedTransform(
      'input.value+1',
      'jsonata-v1',
      ctx,
      abort.signal,
    );
    const child = spy.mock.results[0].value as children.ChildProcess;
    try {
      await once(child, 'spawn');
      child.kill('SIGSTOP');
      abort.abort(new Error('test lease ended'));
      await expect(task).rejects.toThrow('test lease ended');
      expect(child.signalCode).toBe('SIGKILL');
      expect(() => process.kill(child.pid!, 0)).toThrow();
    } finally {
      child.kill('SIGKILL');
      spy.mockRestore();
    }
    await expect(
      isolatedTransform('input.value+1', 'jsonata-v1', ctx),
    ).resolves.toBe(5);
  });
});
