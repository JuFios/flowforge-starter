import WebSocket = require('ws');
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { ExecutionFeed } from '../../src/realtime/execution-feed.service';
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
import { testDatabaseUrl } from '../helpers/test-env';

describe('realtime execution snapshots across API instances', () => {
  let ds: DataSource,
    a: RunningApp,
    b: RunningApp,
    otherListener: Client | undefined,
    socket: WebSocket | undefined;
  beforeAll(async () => {
    ds = await openTestDataSource();
    a = await startApp();
    b = await startApp();
  });
  afterAll(async () => {
    socket?.terminate();
    await otherListener?.end();
    await a.close();
    await b.close();
    await ds.destroy();
  });
  it('reads a pre-subscription commit and resyncs the final commit after its LISTEN connection is terminated', async () => {
    await truncateAll(ds);
    const { tenant, apiKey } = await createTenant(ds);
    const workflow = await createWorkflow(ds, tenant.id);
    const execution = await createExecution(ds, workflow);
    const otherDatabase = new URL(testDatabaseUrl());
    otherDatabase.pathname = '/postgres';
    otherListener = new Client({
      connectionString: otherDatabase.href,
      application_name: 'ff-realtime-listener',
      connectionTimeoutMillis: 5000,
      query_timeout: 5000,
    });
    let otherListenerError: Error | undefined;
    otherListener.on('error', (error: Error) => {
      otherListenerError = error;
    });
    await otherListener.connect();
    await otherListener.query('LISTEN ff_execution');
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
    const states: Array<{
      id: string;
      revision: string;
      status: string;
      workflowName: string | null;
    }> = [];
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
    let listenerPid: number | undefined;
    await waitFor('LISTEN socket in the test database', async () => {
      const [listener] = await ds.query<Array<{ pid: number }>>(
        "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name='ff-realtime-listener' AND state='idle'",
      );
      listenerPid = listener?.pid;
      return listenerPid !== undefined;
    });
    await ds.transaction(async (em) => {
      const [{ terminated }] = await em.query<Array<{ terminated: boolean }>>(
        'SELECT pg_terminate_backend($1) AS terminated',
        [listenerPid],
      );
      expect(terminated).toBe(true);
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
    expect(otherListenerError).toBeUndefined();
    expect((await otherListener.query('SELECT 1 AS live')).rows).toEqual([
      { live: 1 },
    ]);

    const revision = states.at(-1)?.revision;
    expect(
      (
        await api(a.baseUrl, apiKey, 'PATCH', '/workflows/' + workflow.id, {
          name: 'renamed',
        })
      ).status,
    ).toBe(200);
    // Викликаємо штатне повторне читання підписки без очікування періодичного heartbeat.
    const feed = b.app.get(ExecutionFeed);
    feed.events.emit('available', true);
    await waitFor(
      'workflow renamed on the same socket',
      () => states.at(-1)?.workflowName === 'renamed',
    );
    expect(states.at(-1)?.revision).toBe(revision);
    expect(
      (await api(a.baseUrl, apiKey, 'DELETE', '/workflows/' + workflow.id))
        .status,
    ).toBe(204);
    feed.events.emit('available', true);
    await waitFor(
      'workflow name cleared on the same socket',
      () => states.at(-1)?.workflowName === null,
    );
    expect(states.at(-1)?.revision).toBe(revision);
    socket.close();
  });
});
