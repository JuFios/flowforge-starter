import { Response } from 'undici';
import {
  checkAddress,
  outboundTransport,
} from '../../src/engine/outbound-http';
import { StepExecutor } from '../../src/engine/step-executor';

describe('outbound HTTP policy', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '168.63.129.16',
    '::1',
    'fd00::1',
    'fe80::1',
    '::ffff:192.168.1.1',
    '64:ff9b::a00:1',
    '2002::1',
  ])('rejects %s in the address policy', (address) => {
    expect(() => checkAddress(address, 'https://fixture.invalid')).toThrow(
      'destination is not allowed',
    );
  });
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
