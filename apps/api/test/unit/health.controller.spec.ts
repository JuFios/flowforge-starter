import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TerminusModule, TypeOrmHealthIndicator } from '@nestjs/terminus';
import { HealthController } from '../../src/observability/health.controller';

describe('HealthController readiness', () => {
  const pingCheck = jest.fn();
  let controller: HealthController;

  beforeEach(async () => {
    pingCheck.mockReset();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({
      imports: [TerminusModule],
      controllers: [HealthController],
    })
      .overrideProvider(TypeOrmHealthIndicator)
      .useValue({ pingCheck })
      .compile();
    controller = moduleRef.get(HealthController);
  });

  afterEach(() => jest.restoreAllMocks());

  it('reports the database up', async () => {
    pingCheck.mockResolvedValue({ database: { status: 'up' } });
    await expect(controller.readiness()).resolves.toMatchObject({ status: 'ok' });
  });

  it('answers 503 without the driver error details', async () => {
    pingCheck.mockRejectedValue(new Error('connect ECONNREFUSED 10.1.2.3:5432'));
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const error = await controller.readiness().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    const body = JSON.stringify((error as ServiceUnavailableException).getResponse());
    expect(body).toContain('"database":{"status":"down"}');
    expect(body).not.toContain('10.1.2.3');

    // причина не губиться: вона йде в лог (внутрішній), а не у відповідь
    expect(JSON.stringify(warn.mock.calls)).toContain('ECONNREFUSED 10.1.2.3:5432');
  });
});
