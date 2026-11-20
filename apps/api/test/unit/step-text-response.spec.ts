import { Response } from 'undici';
import { outboundTransport } from '../../src/engine/outbound-http';
import { StepExecutor } from '../../src/engine/step-executor';

/** Не-JSON відповідь успішного http-кроку: результат — увесь текст у межах ліміту байтів. */
describe('http step text response', () => {
  const executor = new StepExecutor();
  const ctx = { input: {}, steps: {} };
  const step = {
    id: 'call',
    type: 'http' as const,
    url: 'https://receiver.example/export',
  };

  afterEach(() => jest.restoreAllMocks());

  const respond = (body: string) =>
    jest
      .spyOn(outboundTransport, 'fetch')
      .mockResolvedValue(
        new Response(body, { headers: { 'content-type': 'text/plain' } }),
      );

  it('returns every character of a text longer than 10 000 code units', async () => {
    // Емодзі займає кодові одиниці 9 999–10 000: колишнє обрізання розрізало б пару сурогатів.
    const text = 'a'.repeat(9_999) + '😀' + 'b'.repeat(40_000);
    respond(text);
    await expect(executor.execute(step, ctx)).resolves.toEqual({
      status: 200,
      body: text,
    });
  });

  it('still fails a response larger than HTTP_RESPONSE_BYTES', async () => {
    respond('x'.repeat(1_048_577));
    await expect(executor.execute(step, ctx)).rejects.toMatchObject({
      message: 'http response is too large',
      retryable: false,
    });
  });

  it.each(['9007199254740993', '1e400', '1e-400'])(
    'rejects the inexact JSON number %s as a permanent step error',
    async (raw) => {
      respond(`{"order": ${raw}}`);
      await expect(executor.execute(step, ctx)).rejects.toMatchObject({
        message: 'http response JSON contains an inexact number',
        retryable: false,
      });
    },
  );

  it('preserves the result of a successful response with exact JSON numbers', async () => {
    respond('{"order":9007199254740991,"amount":0.25}');
    await expect(executor.execute(step, ctx)).resolves.toEqual({
      status: 200,
      body: { order: 9007199254740991, amount: 0.25 },
    });
  });
});
