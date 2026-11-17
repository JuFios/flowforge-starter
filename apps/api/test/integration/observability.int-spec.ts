import { Controller, Get } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Execution, Job } from '../../src/entities';
import { MetricsServer } from '../../src/observability/metrics-server';
import { RunningApp, startApp } from '../helpers/app';
import {
  createTenant,
  createWorkflow,
  openTestDataSource,
  TestTenant,
  truncateAll,
} from '../helpers/db';

@Controller('__test')
class FailingController {
  @Get('boom')
  boom(): never {
    throw new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2');
  }
}

describe('API observability and error handling', () => {
  let ds: DataSource;
  let running: RunningApp;
  let tenant: TestTenant;

  beforeAll(async () => {
    ds = await openTestDataSource();
    running = await startApp(undefined, { controllers: [FailingController] });
  });

  beforeEach(async () => {
    await truncateAll(ds);
    tenant = await createTenant(ds);
  });

  afterAll(async () => {
    await running.close();
    await ds.destroy();
  });

  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${running.baseUrl}${path}`, { headers });

  describe('health and readiness', () => {
    it('GET /health reports the process alive', async () => {
      const res = await get('/health');
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: 'ok' });
    });

    it('GET /ready checks the database', async () => {
      const res = await get('/ready');
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        status: 'ok',
        details: { database: { status: 'up' } },
      });
    });
  });

  describe('metrics', () => {
    it('GET /metrics is not served on the public API port', async () => {
      // Порт API опублікований назовні (docker-compose), метрики — лише для збирача у внутрішній мережі.
      const res = await get('/metrics');
      expect(res.status).toBe(404);
      expect(await res.text()).not.toMatch(/process_cpu_user_seconds_total/);
    });

    it('GET /metrics on the metrics port exposes default process metrics in Prometheus format', async () => {
      const port = running.app.get(MetricsServer).port;
      expect(port).toEqual(expect.any(Number));
      const res = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
      const text = await res.text();
      expect(text).toMatch(/^# TYPE process_cpu_user_seconds_total counter$/m);
      expect(text).toMatch(/^nodejs_eventloop_lag_seconds /m);
    });

    it('the metrics port serves nothing but /metrics', async () => {
      const base = `http://127.0.0.1:${running.app.get(MetricsServer).port}`;
      for (const path of [
        '/',
        '/health',
        '/ready',
        '/executions',
        '/metrics/x',
      ]) {
        expect((await fetch(`${base}${path}`)).status).toBe(404);
      }
      expect((await fetch(`${base}/metrics`, { method: 'POST' })).status).toBe(
        404,
      );
    });
  });

  describe('correlation id', () => {
    it('echoes a valid incoming x-request-id', async () => {
      const res = await get('/health', { 'x-request-id': 'client-req-42' });
      expect(res.headers.get('x-request-id')).toBe('client-req-42');
    });

    it('generates an id when none is sent', async () => {
      const res = await get('/health');
      expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('replaces an unsafe incoming id instead of trusting it', async () => {
      const res = await get('/health', { 'x-request-id': 'x'.repeat(200) });
      const id = res.headers.get('x-request-id');
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('is stored on both the execution and its job', async () => {
      const wf = await createWorkflow(ds, tenant.tenant.id);
      const res = await fetch(`${running.baseUrl}/workflows/${wf.id}/run`, {
        method: 'POST',
        headers: {
          'x-api-key': tenant.apiKey,
          'x-request-id': 'run-corr-1',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Ada' }),
      });
      expect(res.status).toBe(201);
      const { id } = (await res.json()) as { id: string };

      const execution = await ds
        .getRepository(Execution)
        .findOneByOrFail({ id });
      const job = await ds
        .getRepository(Job)
        .findOneByOrFail({ executionId: id });
      expect(execution.correlationId).toBe('run-corr-1');
      expect(job.correlationId).toBe('run-corr-1');
    });
  });

  describe('error responses', () => {
    it('do not leak internal error details', async () => {
      const res = await get('/__test/boom', { 'x-request-id': 'boom-1' });
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).not.toMatch(/hunter2|ECONNREFUSED|10\.0\.0\.5|at \w+ \(/);
      expect(JSON.parse(text)).toEqual({
        statusCode: 500,
        message: 'Internal server error',
        correlationId: 'boom-1',
      });
    });

    it('keep intentional client errors and add the correlation id', async () => {
      const res = await get('/executions', { 'x-request-id': 'no-key-1' });
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({
        statusCode: 401,
        correlationId: 'no-key-1',
      });
    });

    it('answer malformed JSON with 400 (client error, not 500) and the correlation id', async () => {
      const res = await fetch(`${running.baseUrl}/workflows`, {
        method: 'POST',
        headers: {
          'x-api-key': tenant.apiKey,
          'content-type': 'application/json',
          'x-request-id': 'bad-json-1',
        },
        body: '{bad',
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        statusCode: 400,
        correlationId: 'bad-json-1',
      });
      expect(JSON.stringify(body)).not.toMatch(/at \w+ \(|node_modules/);
    });

    it('return x-request-id even when the body fails to parse before the correlation middleware runs', async () => {
      const res = await fetch(`${running.baseUrl}/workflows`, {
        method: 'POST',
        headers: {
          'x-api-key': tenant.apiKey,
          'content-type': 'application/json',
        },
        body: '{bad',
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { correlationId?: string };
      expect(body.correlationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(res.headers.get('x-request-id')).toBe(body.correlationId);
    });
  });
});
