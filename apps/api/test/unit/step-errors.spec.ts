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

  it.each([
    [
      'a timeout',
      new DOMException('The operation timed out', 'TimeoutError'),
      'timed out',
    ],
    [
      'an unknown host',
      Object.assign(new TypeError('fetch failed'), {
        cause: { code: 'ENOTFOUND', hostname: 'internal.corp' },
      }),
      'host not found',
    ],
    [
      'a reset connection',
      Object.assign(new TypeError('fetch failed'), {
        cause: { code: 'ECONNRESET', address: '10.0.0.7' },
      }),
      'connection reset',
    ],
  ])(
    'retries %s and names only the class of the network failure',
    async (_case, error, reason) => {
      jest.spyOn(globalThis, 'fetch').mockRejectedValue(error);
      const failure = executor.execute(
        { id: 'call', type: 'http', url: 'https://receiver.example/hook' },
        ctx,
      );
      await expect(failure).rejects.toMatchObject({
        message: `http request failed: ${reason}`,
        retryable: true,
      });
    },
  );

  it('does not retry a request that fetch refuses to send (GET with a body)', async () => {
    // Такий крок відхиляє валідація, але знімок версії міг бути збережений раніше.
    const failure = executor.execute(
      {
        id: 'call',
        type: 'http',
        method: 'GET',
        url: 'https://receiver.example/hook',
        body: 'x',
      },
      ctx,
    );
    await expect(failure).rejects.toMatchObject({
      message: 'http request is invalid',
      retryable: false,
    });
  });

  it('does not retry a request to a port that fetch blocks', async () => {
    // Порт 9 (discard) — у списку заборонених портів специфікації fetch: відмова детермінована.
    const failure = executor.execute(
      { id: 'call', type: 'http', url: 'http://127.0.0.1:9/' },
      ctx,
    );
    await expect(failure).rejects.toMatchObject({
      message: 'http request is invalid: the port is not allowed',
      retryable: false,
    });
  });

  it('fails at once with an explanation when the url is invalid after substitution', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const failure = executor.execute(
      { id: 'call', type: 'http', url: 'http://{{ input.host }}/x' },
      { input: { host: 'a b' }, steps: {} },
    );
    await expect(failure).rejects.toMatchObject({
      message: 'http url is invalid after template substitution',
      retryable: false,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails at once when the substituted url is longer than the url limit', async () => {
    const failure = executor.execute(
      { id: 'call', type: 'http', url: 'https://example.com/{{ input.path }}' },
      { input: { path: 'a'.repeat(2048) }, steps: {} },
    );
    await expect(failure).rejects.toMatchObject({
      message: 'http url is invalid after template substitution',
      retryable: false,
    });
  });

  it('fails at once when the substitution turns the url into a non-http scheme', async () => {
    const failure = executor.execute(
      { id: 'call', type: 'http', url: '{{ input.url }}' },
      { input: { url: 'file:///etc/passwd' }, steps: {} },
    );
    await expect(failure).rejects.toMatchObject({
      message: 'http url is invalid after template substitution',
      retryable: false,
    });
  });
});
