import { StepError, StepExecutor } from '../../src/engine/step-executor';

/**
 * Крок `log`: текст повідомлення — результат кроку (дані тенанта), а не рядок операційного
 * журналу. Текст, який Postgres не зберігає, — неповторювана помилка кроку, а не збій чекпоінта.
 */
describe('log step result', () => {
  const executor = new StepExecutor();

  it('returns the rendered message as the step result', async () => {
    await expect(
      executor.execute(
        { id: 'say', type: 'log', message: 'hello {{ input.name }}' },
        { input: { name: 'Ada' }, steps: {} },
      ),
    ).resolves.toEqual({ logged: true, message: 'hello Ada' });
  });

  it.each([
    ['a lone high surrogate', '\ud800'],
    ['a lone low surrogate', 'x\udc00'],
    ['U+0000', 'a\u0000b'],
  ])(
    'fails without retries when the message would contain %s',
    async (_case, value) => {
      const result = executor.execute(
        { id: 'say', type: 'log', message: 'value {{ input.v }}' },
        { input: { v: value }, steps: {} },
      );
      await expect(result).rejects.toBeInstanceOf(StepError);
      await expect(result).rejects.toMatchObject({ retryable: false });
    },
  );
});
