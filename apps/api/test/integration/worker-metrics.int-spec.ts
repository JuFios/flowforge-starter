import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { Execution } from '../../src/entities';
import { RunningApp, startApp } from '../helpers/app';
import { createTenant, openTestDataSource, truncateAll } from '../helpers/db';
import { api, Receiver, startWorker, waitFor } from '../helpers/queue';

/** Значення ряду метрики з тексту Prometheus (`name{labels} value`), або undefined. */
function sample(text: string, series: string): number | undefined {
  const line = text
    .split('\n')
    .find((l) => l.startsWith(`${series} `) || l === series);
  return line === undefined ? undefined : Number(line.split(' ').pop());
}

describe('queue metrics on the worker /metrics endpoint', () => {
  let ds: DataSource;
  let apiApp: RunningApp;
  let worker: RunningApp;
  const receiver = new Receiver();

  beforeAll(async () => {
    ds = await openTestDataSource();
    await truncateAll(ds);
    apiApp = await startApp(AppModule);
    await receiver.start();
    worker = await startWorker(2);
  });

  afterAll(async () => {
    await worker.close();
    await apiApp.close();
    await receiver.stop();
    await ds.destroy();
  });

  it('reports claim latency, step durations, retries, dead jobs and expired leases', async () => {
    receiver.respond = (req, res) =>
      req.path === '/down'
        ? void res.writeHead(503).end()
        : void res
            .writeHead(200, { 'content-type': 'application/json' })
            .end('{}');
    const { apiKey } = await createTenant(ds);
    const start = async (steps: unknown[]) => {
      const wf = await api<{ id: string }>(
        apiApp.baseUrl,
        apiKey,
        'POST',
        '/workflows',
        { name: 'm', steps },
      );
      return (
        await api<{ id: string }>(
          apiApp.baseUrl,
          apiKey,
          'POST',
          `/workflows/${wf.body.id}/run`,
          {},
        )
      ).body.id;
    };
    const ok = await start([
      { id: 'call', type: 'http', url: receiver.url('/ok') },
    ]);
    const down = await start([
      { id: 'call', type: 'http', url: receiver.url('/down') },
    ]);
    const lost = await start([{ id: 'say', type: 'log', message: 'x' }]);
    await ds.query(
      `UPDATE jobs SET status = 'running', "lockedBy" = 'gone', attempts = 1,
              "lockedUntil" = now() - interval '1 second' WHERE "executionId" = $1`,
      [lost],
    );

    await waitFor('all executions to finish', async () => {
      const rows = await ds
        .getRepository(Execution)
        .findBy([{ id: ok }, { id: down }, { id: lost }]);
      return rows.every((r) => ['succeeded', 'failed'].includes(r.status));
    });

    // Лічильники оновлюються одразу після транзакції, що зафіксувала стан: чекаємо на сам факт у
    // метриках (останні події кожного виконання), а не на час.
    const metrics = async () =>
      (await fetch(`${worker.baseUrl}/metrics`)).text();
    await waitFor('the final events to reach the metrics', async () => {
      const t = await metrics();
      return (
        sample(t, 'flowforge_jobs_dead_total{reason="step_error"}') === 1 &&
        sample(t, 'flowforge_job_leases_expired_total') === 1 &&
        sample(
          t,
          'flowforge_step_duration_seconds_count{type="http",outcome="succeeded"}',
        ) === 1
      );
    });
    const text = await metrics();
    expect(
      sample(text, 'flowforge_job_claim_latency_seconds_count'),
    ).toBeGreaterThanOrEqual(3);
    expect(
      sample(
        text,
        'flowforge_step_duration_seconds_count{type="http",outcome="succeeded"}',
      ),
    ).toBe(1);
    expect(
      sample(
        text,
        'flowforge_step_duration_seconds_count{type="http",outcome="failed"}',
      ),
    ).toBe(3);
    expect(
      sample(text, 'flowforge_job_retries_total{reason="step_error"}'),
    ).toBe(2);
    expect(
      sample(text, 'flowforge_job_retries_total{reason="lease_expired"}'),
    ).toBe(1);
    expect(sample(text, 'flowforge_jobs_dead_total{reason="step_error"}')).toBe(
      1,
    );
    expect(
      sample(text, 'flowforge_jobs_dead_total{reason="lease_expired"}'),
    ).toBe(0);
    expect(sample(text, 'flowforge_job_leases_expired_total')).toBe(1);
  });
});
