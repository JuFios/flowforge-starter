import { DataSource } from 'typeorm';
import { WorkerModule } from '../../src/app.module';
import { MetricsServer } from '../../src/observability/metrics-server';
import { OutboxSender } from '../../src/outbox/outbox-sender.service';
import { SchedulerService } from '../../src/scheduler/scheduler.service';
import { RunningApp, startApp } from '../helpers/app';
import {
  createExecution,
  createTenant,
  createWorkflow,
  openTestDataSource,
  truncateAll,
} from '../helpers/db';
import { configureNotifications } from '../helpers/notifications';
import { Receiver, sleep } from '../helpers/queue';
import { createScheduledWorkflow, tenantCall } from '../helpers/schedule';

/** Значення ряду метрики з тексту Prometheus (`name{labels} value`), або undefined. */
function sample(text: string, series: string): number | undefined {
  const line = text
    .split('\n')
    .find((l) => l.startsWith(`${series} `) || l === series);
  return line === undefined ? undefined : Number(line.split(' ').pop());
}

/**
 * Метрики сповіщень і планувальника (ТЗ 3.3.10, docs/operations.md «Метрики»): значення після відомої
 * послідовності операцій на справжніх `/metrics` воркера й API, а не лише наявність назв.
 */
describe('outbox and scheduler metrics', () => {
  let ds: DataSource;
  let apiApp: RunningApp;
  let worker: RunningApp;
  const receiver = new Receiver();

  beforeAll(async () => {
    ds = await openTestDataSource();
    await truncateAll(ds);
    await receiver.start();
    apiApp = await startApp();
    worker = await startApp(WorkerModule);
  });
  afterAll(async () => {
    await worker.close();
    await apiApp.close();
    await receiver.stop();
    await truncateAll(ds);
    await ds.destroy();
  });

  it('counts attempts by outcome and reports the backlog per tenant', async () => {
    const { tenant, apiKey } = await createTenant(ds);
    await configureNotifications(apiApp, apiKey, receiver.url('/n'));
    let answer = 200;
    receiver.respond = (_req, res) => {
      res.writeHead(answer).end();
    };
    const wf = await createWorkflow(ds, tenant.id);
    for (let i = 0; i < 3; i++) {
      const e = await createExecution(ds, wf);
      await ds.query(
        `UPDATE executions SET status = 'succeeded', "finishedAt" = now() WHERE id = $1`,
        [e.id],
      );
    }
    const sender = worker.app.get(OutboxSender);
    await sender.deliverNext(); // delivered
    answer = 503;
    await sender.deliverNext(); // http_error
    const text = await (await fetch(`${worker.baseUrl}/metrics`)).text();
    expect(
      sample(text, 'flowforge_outbox_attempts_total{outcome="delivered"}'),
    ).toBe(1);
    expect(
      sample(text, 'flowforge_outbox_attempts_total{outcome="http_error"}'),
    ).toBe(1);
    expect(
      sample(
        text,
        'flowforge_outbox_attempt_duration_seconds_count{outcome="delivered"}',
      ),
    ).toBe(1);
    // Дві недоставлені події тенанта (одна на повторі, одна ще не пробувана), жодна не надсилається.
    expect(
      sample(text, `flowforge_outbox_pending{tenant_id="${tenant.id}"}`),
    ).toBe(2);
    expect(sample(text, 'flowforge_outbox_events{state="pending"}')).toBe(2);
    expect(sample(text, 'flowforge_outbox_events{state="sending"}')).toBe(0);
    expect(
      sample(text, 'flowforge_outbox_oldest_pending_age_seconds'),
    ).toBeGreaterThan(0);
    // Мітки — без URL, секретів і ID подій.
    expect(text).not.toContain(receiver.url('/n'));
    const [{ id }]: Array<{ id: string }> = await ds.query(
      'SELECT id FROM outbox_events LIMIT 1',
    );
    expect(text).not.toContain(id);
  });

  it('counts created firings, held firings and the lag on the API metrics port', async () => {
    const scheduler = apiApp.app.get(SchedulerService);
    scheduler.onApplicationShutdown();
    const { tenant, apiKey } = await createTenant(ds, 'scheduled');
    const port = apiApp.app.get(MetricsServer).port as number;
    const read = async () =>
      (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
    const before = await read();
    const created = (t: string) =>
      sample(t, 'flowforge_schedule_firings_total{outcome="created"}') ?? 0;
    const held = (t: string) =>
      sample(t, 'flowforge_schedule_blocked_total{reason="queue_full"}') ?? 0;
    const wf = await createScheduledWorkflow(apiApp, ds, apiKey, {
      cron: '* * * * * *',
    });
    await sleep(2_200);
    const fired = await scheduler.tick();
    expect(fired).toBeGreaterThanOrEqual(2);
    const after = await read();
    expect(created(after) - created(before)).toBe(fired);
    expect(
      (sample(after, 'flowforge_schedule_lag_seconds_count') ?? 0) -
        (sample(before, 'flowforge_schedule_lag_seconds_count') ?? 0),
    ).toBe(fired);
    // Черга повна: спрацювання відкладено й пораховано, курсор стоїть.
    await ds.query('UPDATE tenants SET "maxQueueSize" = 1 WHERE id = $1', [
      tenant.id,
    ]);
    await ds.query(
      `UPDATE workflows SET "scheduleCursor"=now()-interval '5 minutes', "nextFireAt"=now() WHERE id=$1`,
      [wf.id],
    );
    const missed = (t: string) =>
      sample(
        t,
        'flowforge_schedule_firings_total{outcome="missed_run_once"}',
      ) ?? 0;
    for (let i = 0; i < 2; i++) expect(await scheduler.tick()).toBe(0);
    const blocked = await read();
    expect(held(blocked) - held(after)).toBe(2);
    expect(missed(blocked)).toBe(missed(after));
    await ds.query('UPDATE tenants SET "maxQueueSize"=100 WHERE id=$1', [
      tenant.id,
    ]);
    await scheduler.tick();
    expect(missed(await read()) - missed(after)).toBe(1);
    expect(
      (await tenantCall(apiApp, apiKey, 'GET', `/workflows/${wf.id}`)).status,
    ).toBe(200);
  });
});
