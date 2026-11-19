import { QueueDepthMetrics } from '../../src/engine/queue-depth.metrics';
import { MetricsService } from '../../src/observability/metrics.service';
import { SystemDb } from '../../src/tenancy/system-db';

/**
 * `flowforge_queue_depth_collect_errors_total` рахує невдалі читання з БД, а не скрейпи: одночасні
 * скрейпи (напр. HA-пара Prometheus) чекають на одне читання й не множать одну помилку.
 */
describe('queue depth read errors', () => {
  function setup(): {
    metrics: MetricsService;
    read: jest.Mock;
  } {
    const metrics = new MetricsService();
    const read = jest.fn(
      () =>
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error('database unavailable')), 20),
        ),
    );
    new QueueDepthMetrics(metrics, {
      queueDepthByTenant: read,
    } as unknown as SystemDb);
    return { metrics, read };
  }

  function errors(text: string): number {
    return Number(
      /^flowforge_queue_depth_collect_errors_total (\S+)$/m.exec(text)?.[1] ??
        NaN,
    );
  }

  it('counts one failed read once for concurrent scrapes', async () => {
    const { metrics, read } = setup();
    const [first, second] = await Promise.all([
      metrics.render(),
      metrics.render(),
    ]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(errors(first)).toBe(1);
    expect(errors(second)).toBe(1);
  });

  it('counts each failed read of consecutive scrapes', async () => {
    const { metrics, read } = setup();
    await metrics.render();
    const text = await metrics.render();
    expect(read).toHaveBeenCalledTimes(2);
    expect(errors(text)).toBe(2);
  });
});
