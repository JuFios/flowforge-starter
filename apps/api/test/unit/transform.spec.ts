import { StepExecutor } from '../../src/engine/step-executor';
describe('transform boundaries', () => {
  const execute = (expr: string, input: Record<string, unknown> = {}) =>
    new StepExecutor().execute(
      { type: 'transform', id: 'shape', expr },
      { input, steps: {} },
    );
  it('evaluates bounded new definitions in a child process', async () => {
    await expect(
      new StepExecutor().execute(
        {
          type: 'transform',
          id: 'shape',
          language: 'jsonata-v1',
          expr: '{"total": input.n * 2}',
        },
        { input: { n: 3 }, steps: {} },
      ),
    ).resolves.toEqual({ total: 6 });
  });
  it('rejects host language functions in stored workflow definitions', async () => {
    await expect(execute('Math.abs(-4)')).rejects.toMatchObject({
      retryable: false,
    });
  });
  it('rejects an oversized value reached through a stored field path', async () => {
    await expect(
      execute('ctx.input.value', { value: 'x'.repeat(65537) }),
    ).rejects.toMatchObject({ retryable: false });
  });
});
