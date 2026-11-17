import { Controller, Get } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RunningApp, startApp } from '../helpers/app';
import { createTenant, openTestDataSource, TestTenant, truncateAll } from '../helpers/db';

@Controller('__test')
class FailingController {
  @Get('boom')
  boom(): never {
    throw new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2');
  }
}

/** Помилки, що виникають до контролера (body-parser), і те, що про них потрапляє в лог. */
describe('error responses and their log records', () => {
  let ds: DataSource;
  let running: RunningApp;
  let tenant: TestTenant;

  beforeAll(async () => {
    ds = await openTestDataSource();
    running = await startApp(undefined, { controllers: [FailingController], captureLogs: true });
  });

  beforeEach(async () => {
    await truncateAll(ds);
    tenant = await createTenant(ds);
    running.logs.length = 0;
  });

  afterAll(async () => {
    await running.close();
    await ds.destroy();
  });

  const postWorkflow = (body: string, headers: Record<string, string> = {}) =>
    fetch(`${running.baseUrl}/workflows`, {
      method: 'POST',
      headers: { 'x-api-key': tenant.apiKey, 'content-type': 'application/json', ...headers },
      body,
    });

  async function expectClientError(res: Response, status: number, message: string) {
    expect(res.status).toBe(status);
    const text = await res.text();
    expect(text).not.toMatch(/node_modules|body-parser|raw-body|at \w+ \(/);
    const body = JSON.parse(text) as { correlationId: string };
    expect(body).toEqual({ statusCode: status, message, correlationId: expect.any(String) });
    expect(res.headers.get('x-request-id')).toBe(body.correlationId);
    return body.correlationId;
  }

  it('answers an oversized body with 413', async () => {
    const res = await postWorkflow(JSON.stringify({ name: 'x'.repeat(200_000) }));
    await expectClientError(res, 413, 'Payload Too Large');
  });

  it('answers an unsupported content encoding with 415', async () => {
    const res = await postWorkflow('{}', { 'content-encoding': 'x-unknown' });
    await expectClientError(res, 415, 'Unsupported Media Type');
  });

  it('answers an unsupported charset with 415', async () => {
    const res = await postWorkflow('{}', { 'content-type': 'application/json; charset=koi8-r' });
    await expectClientError(res, 415, 'Unsupported Media Type');
  });

  it('still answers malformed JSON with 400', async () => {
    const res = await postWorkflow('{bad');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { correlationId: string };
    expect(res.headers.get('x-request-id')).toBe(body.correlationId);
  });

  it('logs a body-parser error as a warning with the correlation id returned to the client', async () => {
    const res = await postWorkflow(JSON.stringify({ name: 'x'.repeat(200_000) }), { 'x-request-id': 'too-big-1' });
    expect(res.status).toBe(413);
    const record = running.logs.find((l) => l.context === 'ExceptionsFilter');
    expect(record).toMatchObject({ level: 40, correlationId: 'too-big-1', status: 413 });
    expect(record?.error).toMatchObject({ type: 'PayloadTooLargeError' });
  });

  it('logs an unhandled error with its real type, the correlation id and no secrets', async () => {
    const res = await fetch(`${running.baseUrl}/__test/boom`, { headers: { 'x-request-id': 'boom-log-1' } });
    expect(res.status).toBe(500);
    const records = running.logs.filter((l) => l.context === 'ExceptionsFilter');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ level: 50, correlationId: 'boom-log-1' });
    expect(records[0].error).toMatchObject({ type: 'Error' });
    // повідомлення помилки лишається в лозі (це наш власний код), але не у відповіді
    expect(JSON.stringify(await res.json())).not.toContain('hunter2');
  });
});
