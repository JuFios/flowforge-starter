import { StepError, StepExecutor } from '../../src/engine/step-executor';

/** Яка відповідь отримувача дає повторювану помилку кроку http, а яка — остаточну. */
describe('http step error classification', () => {
  const executor = new StepExecutor();
  const ctx = { input: {}, steps: {} };

  afterEach(() => jest.restoreAllMocks());

  async function failureFor(status: number): Promise<StepError> {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('busy', { status }));
    try {
      await executor.execute(
        { id: 'call', type: 'http', url: 'https://receiver.example/hook' },
        ctx,
      );
    } catch (err) {
      expect(err).toBeInstanceOf(StepError);
      return err as StepError;
    }
    throw new Error(`status ${status} did not fail the step`);
  }

  it.each([408, 425, 429, 500, 502, 503, 504])(
    'retries a temporary failure (HTTP %i)',
    async (status) => {
      expect((await failureFor(status)).retryable).toBe(true);
    },
  );

  it.each([400, 401, 403, 404, 410, 422])(
    'does not retry a permanent failure (HTTP %i)',
    async (status) => {
      expect((await failureFor(status)).retryable).toBe(false);
    },
  );
});
