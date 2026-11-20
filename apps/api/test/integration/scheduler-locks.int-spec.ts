import { DataSource } from 'typeorm';
import { SchedulerService } from '../../src/scheduler/scheduler.service';
import { RunningApp, startApp } from '../helpers/app';
import { createTenant, openTestDataSource, truncateAll } from '../helpers/db';
import { dbNow, scheduledTimes, tenantCall } from '../helpers/schedule';
import { signedHeaders } from '../helpers/webhook';

/**
 * Порядок блокувань (README, «Порядок блокувань»): спрацювання розкладу (workflow → облік тенанта
 * → задача) не утворює циклу з webhook-ом (тенант → workflow → облік), запуском через API (облік),
 * редагуванням (workflow) і видаленням того самого workflow.
 */
describe('scheduler lock order', () => {
  let ds: DataSource;
  let app: RunningApp;

  beforeAll(async () => {
    ds = await openTestDataSource();
    await truncateAll(ds);
    app = await startApp(undefined, { captureLogs: true });
    app.app.get(SchedulerService).onApplicationShutdown();
  });
  afterAll(async () => {
    await app.close();
    await truncateAll(ds);
    await ds.destroy();
  });

  it('runs firings, webhooks, runs, edits and a delete of the same workflow concurrently without a deadlock', async () => {
    const { apiKey, tenant } = await createTenant(ds);
    const res = await tenantCall(app, apiKey, 'POST', '/workflows', {
      name: 'busy',
      steps: [{ id: 'say', type: 'log', message: 'x' }],
      cron: '* * * * * *',
      missedRunPolicy: 'run_all',
    });
    const { id } = (await res.json()) as { id: string };
    // Пропуск у 50 секундних моментів: тік довго працює з цим рядком.
    await ds.query(
      `UPDATE workflows SET "scheduleCursor" = now() - interval '50 seconds' WHERE id = $1`,
      [id],
    );
    const scheduler = app.app.get(SchedulerService);
    const body = JSON.stringify({ n: 1 });
    const hook = () =>
      fetch(`${app.baseUrl}/hooks/${id}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...signedHeaders(id, tenant.webhookSecret, body),
        },
        body,
      }).then((r) => r.status);
    const run = () =>
      tenantCall(app, apiKey, 'POST', `/workflows/${id}/run`, {}).then(
        (r) => r.status,
      );
    const edit = (i: number) =>
      tenantCall(app, apiKey, 'PATCH', `/workflows/${id}`, {
        name: `busy-${i}`,
      }).then((r) => r.status);
    const ticking = scheduler.tick();
    const statuses = await Promise.all([
      ...Array.from({ length: 10 }, hook),
      ...Array.from({ length: 10 }, run),
      ...Array.from({ length: 10 }, (_, i) => edit(i)),
    ]);
    expect(statuses.filter((s) => s >= 500)).toEqual([]);
    const removed = tenantCall(app, apiKey, 'DELETE', `/workflows/${id}`);
    await ticking;
    expect((await removed).status).toBe(204);
    const fired = await scheduledTimes(ds, id);
    expect(new Set(fired).size).toBe(fired.length);
    expect(fired.length).toBeGreaterThan(0);
    expect(
      app.logs.filter((l) => JSON.stringify(l).includes('deadlock')),
    ).toEqual([]);
    expect(await dbNow(ds)).toBeInstanceOf(Date);
  });
});
