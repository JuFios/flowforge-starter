import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { SystemDb } from '../../src/tenancy/system-db';
import { tokenHash } from '../../src/sessions/sessions.service';
import {
  createTenant,
  createWorkflow,
  createExecution,
  openTestDataSource,
  truncateAll,
} from '../helpers/db';
import { RunningApp, startApp } from '../helpers/app';

describe('browser sessions and single-use realtime tickets', () => {
  let ds: DataSource, a: RunningApp, b: RunningApp;
  beforeAll(async () => {
    ds = await openTestDataSource();
    a = await startApp(undefined, { captureLogs: true });
    b = await startApp(undefined, { captureLogs: true });
  });
  beforeEach(() => truncateAll(ds));
  afterAll(async () => {
    await b.close();
    await a.close();
    await ds.destroy();
  });

  it('exchanges the key for a scoped session, consumes a ticket only once across instances, then revokes access', async () => {
    const { tenant, apiKey } = await createTenant(ds);
    const wf = await createWorkflow(ds, tenant.id);
    const run = await createExecution(ds, wf);
    const login = await fetch(a.baseUrl + '/sessions', {
      method: 'POST',
      headers: { 'x-api-key': apiKey },
    });
    expect(login.status).toBe(201);
    expect(login.headers.get('cache-control')).toBe('no-store');
    const { token } = (await login.json()) as { token: string };
    const headers = { authorization: 'Bearer ' + token };
    expect((await fetch(b.baseUrl + '/workflows', { headers })).status).toBe(
      200,
    );
    expect(
      (await fetch(b.baseUrl + '/sessions', { method: 'POST', headers }))
        .status,
    ).toBe(401);
    const other = await createTenant(ds, 'other');
    const foreign = await createExecution(
      ds,
      await createWorkflow(ds, other.tenant.id),
    );
    expect(
      (
        await fetch(
          b.baseUrl + '/executions/' + foreign.id + '/realtime-tickets',
          { method: 'POST', headers },
        )
      ).status,
    ).toBe(404);
    const issue = async () => {
      const res = await fetch(
        b.baseUrl + '/executions/' + run.id + '/realtime-tickets',
        { method: 'POST', headers },
      );
      expect(res.status).toBe(201);
      return ((await res.json()) as { ticket: string }).ticket;
    };
    const ticket = await issue();
    const claims = await Promise.all(
      [a, b].map((node) =>
        node.app.get(SystemDb).redeemTicket(tokenHash(ticket)),
      ),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)).toMatchObject({
      executionId: run.id,
      tenantId: tenant.id,
    });
    const revoked = await issue();
    expect(
      (
        await fetch(b.baseUrl + '/sessions/current', {
          method: 'DELETE',
          headers,
        })
      ).status,
    ).toBe(204);
    expect((await fetch(a.baseUrl + '/workflows', { headers })).status).toBe(
      401,
    );
    expect(
      await b.app.get(SystemDb).redeemTicket(tokenHash(revoked)),
    ).toBeUndefined();
    const logs = JSON.stringify([...a.logs, ...b.logs]);
    for (const secret of [apiKey, token, ticket, revoked])
      expect(logs).not.toContain(secret);
  });
  it('enforces expiry using the database clock', async () => {
    const { tenant, apiKey } = await createTenant(ds);
    const res = await fetch(a.baseUrl + '/sessions', {
      method: 'POST',
      headers: { 'x-api-key': apiKey },
    });
    const { token } = (await res.json()) as { token: string };
    await ds.query(
      'UPDATE browser_sessions SET "expiresAt"=clock_timestamp() WHERE "tenantId"=$1',
      [tenant.id],
    );
    expect(
      (
        await fetch(b.baseUrl + '/workflows', {
          headers: { authorization: 'Bearer ' + token },
        })
      ).status,
    ).toBe(401);
    expect(
      await a.app.get(SystemDb).redeemTicket(tokenHash(randomUUID())),
    ).toBeUndefined();
  });
});
