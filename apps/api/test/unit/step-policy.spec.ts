import { Response } from 'undici';
import { outboundTransport } from '../../src/engine/outbound-http';
import { StepExecutor } from '../../src/engine/step-executor';

describe('outbound HTTP policy', () => {
  afterEach(() => jest.restoreAllMocks());
  it('rejects a non-public literal before dispatching any request', async () => {
    const transport = jest
      .spyOn(outboundTransport, 'fetch')
      .mockResolvedValue(new Response('{}'));
    await expect(
      new StepExecutor().execute(
        { id: 'check', type: 'http', url: 'http://192.0.2.1/example' },
        { input: {}, steps: {} },
      ),
    ).rejects.toMatchObject({ retryable: false });
    expect(transport).not.toHaveBeenCalled();
  });
});
