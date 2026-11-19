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

  const jsonata = (expr: string, input: Record<string, unknown>) =>
    new StepExecutor().execute(
      { type: 'transform', id: 'shape', language: 'jsonata-v1', expr },
      { input, steps: {} },
    );
  it('returns null for a path without a value, like the stored field path', async () => {
    await expect(jsonata('input.missing', {})).resolves.toBeNull();
    await expect(execute('ctx.input.missing')).resolves.toBeNull();
    await expect(
      jsonata('{"present": input.n, "absent": input.missing}', { n: 1 }),
    ).resolves.toEqual({ present: 1 });
  });
  it('reports an evaluation error separately from a profile violation', async () => {
    await expect(
      jsonata('input.name + 1', { name: 'Ada' }),
    ).rejects.toMatchObject({
      message: 'transform: expression evaluation failed',
      retryable: false,
    });
    await expect(execute('ctx.input.missing.deeper')).rejects.toMatchObject({
      message: 'transform: expression evaluation failed',
      retryable: false,
    });
    await expect(
      jsonata(
        '[input.items, input.items, input.items, input.items, input.items]',
        {
          items: Array.from({ length: 5000 }, (_, i) => i),
        },
      ),
    ).rejects.toMatchObject({
      message: 'transform: expression or result exceeds the supported profile',
      retryable: false,
    });
  });
  it('estimates intermediate data by the value each path reads, not the whole context', async () => {
    // Великий сусідній рядок у контексті не робить дешеві скалярні посилання недопустимими.
    const input = { blob: 'x'.repeat(1_100_000), a: 1 };
    const fields = Array.from({ length: 12 }, (_, i) => `"k${i}": input.a`);
    await expect(jsonata(`{${fields.join(', ')}}`, input)).resolves.toEqual(
      Object.fromEntries(fields.map((_, i) => [`k${i}`, 1])),
    );
    // Посилання на сам великий рядок рахуються повністю: восьме перевищує 8 МіБ.
    const big = Array.from({ length: 8 }, () => 'input.blob = "y"');
    await expect(jsonata(`[${big.join(', ')}]`, input)).rejects.toMatchObject({
      message: 'transform: expression or result exceeds the supported profile',
    });
    await expect(
      jsonata(`[${big.slice(1).join(', ')}]`, input),
    ).resolves.toEqual(Array(7).fill(false));
  });
});
