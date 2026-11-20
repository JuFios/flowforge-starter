import WebSocket = require('ws');
import { DataSource } from 'typeorm';
import {
  createTenant,
  createExecution,
  createWorkflow,
  openTestDataSource,
  truncateAll,
} from '../helpers/db';
import { RunningApp, startApp } from '../helpers/app';
import { waitFor } from '../helpers/wait-for';
import { api } from '../helpers/queue';

describe('realtime execution snapshots across API instances', () => {
  let ds: DataSource,
    a: RunningApp,
    b: RunningApp,
    socket: WebSocket | undefined;
  beforeAll(async () => {
    ds = await openTestDataSource();
    a = await startApp();
    b = await startApp();
  });
  afterAll(async () => {
    socket?.terminate();
    await a.close();
    await b.close();
    await ds.destroy();
  });
  it('reads a pre-subscription commit and resyncs the final commit after its LISTEN connection is terminated', async () => {
    await truncateAll(ds);
    const { tenant, apiKey } = await createTenant(ds);
    const execution = await createExecution(
      ds,
      await createWorkflow(ds, tenant.id),
    );
    const ticket = await api<{ ticket: string }>(
      a.baseUrl,
      apiKey,
      'POST',
      '/executions/' + execution.id + '/realtime-tickets',
    );
    expect(ticket.status).toBe(201);
    await ds.query("UPDATE executions SET status='running' WHERE id=$1", [
      execution.id,
    ]);
    const states: Array<{ id: string; revision: string; status: string }> = [];
    socket = new WebSocket(
      b.baseUrl.replace('http:', 'ws:') +
        '/realtime?ticket=' +
        ticket.body.ticket,
    );
    socket.on('message', (raw) => {
      const event = JSON.parse(
        (Buffer.isBuffer(raw)
          ? raw
          : Buffer.concat(Array.isArray(raw) ? raw : [Buffer.from(raw)])
        ).toString(),
      ) as {
        execution?: (typeof states)[number];
      };
      if (event.execution) states.push(event.execution);
    });
    await waitFor('initial running snapshot', () =>
      states.some((s) => s.status === 'running'),
    );
    await waitFor(
      'LISTEN socket',
      async () =>
        (
          await ds.query<Array<{ pid: number }>>(
            "SELECT pid FROM pg_stat_activity WHERE application_name='ff-realtime-listener' AND state='idle'",
          )
        ).length === 1,
    );
    await ds.transaction(async (em) => {
      await em.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='ff-realtime-listener'",
      );
      await em.query(
        'UPDATE executions SET status=\'succeeded\', "finishedAt"=clock_timestamp() WHERE id=$1',
        [execution.id],
      );
    });
    await waitFor(
      'terminal snapshot on the same WebSocket',
      () => states.some((s) => s.status === 'succeeded'),
      { timeoutMs: 5000 },
    );
    expect(states.at(-1)?.id).toBe(execution.id);
    expect(BigInt(states.at(-1)!.revision)).toBeGreaterThan(
      BigInt(states[0].revision),
    );
    socket.close();
  });
});
