import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { Execution } from '../../src/entities';
import { RunningApp, startApp } from '../helpers/app';
import { createTenant, openTestDataSource, truncateAll } from '../helpers/db';
import { api, Receiver, startWorker, waitFor } from '../helpers/queue';

const INTERNAL = 'internal detail: relation pg_secret at 10.0.0.7';

/** Помилки, які бачить тенант (`GET /executions/:id`), не розкривають внутрішніх деталей. */
describe('execution errors shown to the tenant', () => {
  let ds: DataSource;
  let apiApp: RunningApp;
  let worker: RunningApp | undefined;
  const receiver = new Receiver();
  let apiKey: string;

  beforeAll(async () => {
    ds = await openTestDataSource();
    apiApp = await startApp(AppModule);
    await receiver.start();
    // Внутрішній збій: кожна спроба записати результат кроку обривається помилкою БД.
    await ds.query(`
      CREATE OR REPLACE FUNCTION test_fail_checkpoint() RETURNS trigger AS $$
      BEGIN
        IF NEW.status = 'succeeded' THEN RAISE EXCEPTION '${INTERNAL}'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
  });

  beforeEach(async () => {
    await truncateAll(ds);
    ({ apiKey } = await createTenant(ds));
  });

  afterEach(async () => {
    await ds.query(`DROP TRIGGER IF EXISTS test_fail_checkpoint ON step_runs`);
    await worker?.close();
    worker = undefined;
  });

  afterAll(async () => {
    await ds.query(`DROP FUNCTION IF EXISTS test_fail_checkpoint()`);
    await apiApp.close();
    await receiver.stop();
    await ds.destroy();
  });

  async function runToFailure(steps: unknown[]) {
    const wf = await api<{ id: string }>(
      apiApp.baseUrl,
      apiKey,
      'POST',
      '/workflows',
      { name: 'errors', steps },
    );
    const id = (
      await api<{ id: string }>(
        apiApp.baseUrl,
        apiKey,
        'POST',
        `/workflows/${wf.body.id}/run`,
        {},
      )
    ).body.id;
    worker = await startWorker(1);
    await waitFor(
      'the execution to fail',
      async () =>
        (await ds.getRepository(Execution).findOneByOrFail({ id })).status ===
        'failed',
    );
    return (
      await api<{ error: string; steps: Array<{ error: string | null }> }>(
        apiApp.baseUrl,
        apiKey,
        'GET',
        `/executions/${id}`,
      )
    ).body;
  }

  it('does not expose the text of an internal error', async () => {
    await ds.query(`
      CREATE TRIGGER test_fail_checkpoint BEFORE UPDATE ON step_runs
      FOR EACH ROW EXECUTE FUNCTION test_fail_checkpoint()`);
    const body = await runToFailure([
      { id: 'say', type: 'log', message: 'hi' },
    ]);

    const shown = JSON.stringify(body);
    expect(shown).not.toContain('pg_secret');
    expect(shown).not.toContain('10.0.0.7');
    expect(body.error).toMatch(/^internal error/);
  });

  it('keeps an actionable message for errors of the step itself', async () => {
    receiver.respond = (_req, res) => void res.writeHead(404).end();
    const body = await runToFailure([
      { id: 'call', type: 'http', url: receiver.url('/missing') },
    ]);
    expect(body.error).toBe('http 404');
    expect(body.steps[0].error).toBe('http 404');
  });

  it('reports an unreachable receiver without the network details of the failure', async () => {
    const body = await runToFailure([
      // Порт 9 (discard) на loopback закритий: з'єднання відхиляється.
      { id: 'call', type: 'http', url: 'http://127.0.0.1:9/' },
    ]);
    expect(body.error).toMatch(/^http request failed/);
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED 127.0.0.1');
  });
});
