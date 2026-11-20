import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { RunningApp, startApp } from '../helpers/app';
import { createTenant, openTestDataSource, truncateAll } from '../helpers/db';
import { api, Receiver, startWorker, waitFor } from '../helpers/queue';
import { waitForBlocked } from '../helpers/transaction-barrier';

describe('write-only workflow headers', () => {
  let ds: DataSource;
  let app: RunningApp;
  let worker: RunningApp | undefined;
  let key: string;
  const receiver = new Receiver();
  const secret = 'test-value-' + randomUUID();
  const stored = { stored: true };
  const keep = { keep: true };
  const call = (method: string, path: string, body?: unknown) =>
    api<{
      id: string;
      editRevision: string;
      version: number;
      steps: Array<{ headers?: Record<string, unknown> }>;
    }>(app.baseUrl, key, method, path, body);
  const http = (headers: Record<string, unknown>) => ({
    id: 'call',
    type: 'http',
    url: receiver.url('/headers'),
    headers,
  });
  const run = (workflow: string) => call('POST', workflow + '/run', {});

  beforeAll(async () => {
    ds = await openTestDataSource();
    app = await startApp(undefined, { captureLogs: true });
    await receiver.start();
  });
  beforeEach(async () => {
    await truncateAll(ds);
    ({ apiKey: key } = await createTenant(ds));
    receiver.requests.length = 0;
  });
  afterEach(async () => {
    await worker?.close();
    worker = undefined;
  });
  afterAll(async () => {
    await receiver.stop();
    await app.close();
    await ds.destroy();
  });

  it('masks current and legacy definitions on create, read and update', async () => {
    const steps = [http({ Authorization: secret, 'X-Custom': secret })];
    const created = await call('POST', '/workflows', {
      name: 'original',
      steps,
    });
    expect(created.status).toBe(201);
    const id = created.body.id;
    await ds.query('UPDATE workflows SET steps=$2::jsonb WHERE id=$1', [
      id,
      JSON.stringify(steps),
    ]);
    for (const response of [
      created,
      await call('GET', '/workflows/' + id),
      await call('PATCH', '/workflows/' + id, { name: 'changed' }),
    ]) {
      expect(response.body.steps[0].headers).toEqual({
        Authorization: stored,
        'X-Custom': stored,
      });
      expect(JSON.stringify(response.body)).not.toContain(secret);
    }
    expect(JSON.stringify(app.logs)).not.toContain(secret);
  });

  it('delivers retained, replaced and removed values from the version selected at enqueue', async () => {
    const created = await call('POST', '/workflows', {
      name: 'outgoing',
      steps: [http({ 'X-Value': secret })],
    });
    const path = '/workflows/' + created.body.id;
    let editRevision = created.body.editRevision;
    for (const value of [keep, 'replacement', undefined]) {
      const queued = await run(path);
      expect(queued.status).toBe(201);
      const headers = value === undefined ? {} : { 'x-value': value };
      const updated = await call('PATCH', path, {
        editRevision,
        steps: [{ id: 'other', type: 'log', message: 'test' }, http(headers)],
      });
      expect(updated.status).toBe(200);
      editRevision = updated.body.editRevision;
    }
    expect((await run(path)).status).toBe(201);
    worker = await startWorker(1);
    await waitFor(
      'four versioned HTTP requests',
      () => receiver.requests.length === 4,
    );
    const values = receiver.requests.map((r) => r.headers['x-value']);
    expect(values.filter((v) => v === secret)).toHaveLength(2);
    expect(values.filter((v) => v === 'replacement')).toHaveLength(1);
    expect(values.filter((v) => v === undefined)).toHaveLength(1);
  });

  it('rejects a stale retain request after waiting for a concurrent edit', async () => {
    const created = await call('POST', '/workflows', {
      name: 'concurrent',
      steps: [http({ 'X-V': secret })],
    });
    const id = created.body.id;
    const holder = ds.createQueryRunner();
    await holder.connect();
    await holder.startTransaction();
    try {
      await holder.query(
        'UPDATE workflows SET steps=$2::jsonb, "editRevision"="editRevision"+1 WHERE id=$1',
        [id, JSON.stringify([http({ 'X-V': 'new' })])],
      );
      const pending = call('PATCH', '/workflows/' + id, {
        editRevision: created.body.editRevision,
        steps: [http({ 'x-v': keep })],
      });
      await waitForBlocked(ds, holder);
      await holder.commitTransaction();
      expect((await pending).status).toBe(409);
      const rows = await ds.query<Array<{ v: string }>>(
        `SELECT steps->0->'headers'->>'X-V' AS v FROM workflows WHERE id=$1`,
        [id],
      );
      expect(rows).toEqual([{ v: 'new' }]);
    } finally {
      if (holder.isTransactionActive) await holder.rollbackTransaction();
      await holder.release();
    }
  });

  it('rejects ambiguous names, response markers and missing retained values', async () => {
    const create = (headers: Record<string, unknown>) =>
      call('POST', '/workflows', { name: 'headers', steps: [http(headers)] });
    expect((await create({ 'X-A': keep })).status).toBe(400);
    expect((await create({ 'X-A': secret, 'x-a': 'second' })).status).toBe(400);
    const created = await create({ 'X-A': secret });
    const id = created.body.id;
    for (const headers of [{ 'X-A': stored }, { 'X-B': keep }]) {
      const res = await call('PATCH', '/workflows/' + id, {
        steps: [http(headers)],
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).not.toContain(secret);
    }
    await ds.query('UPDATE workflows SET steps=$2::jsonb WHERE id=$1', [
      id,
      JSON.stringify([http({ 'X-Legacy': 'first', 'x-legacy': 'second' })]),
    ]);
    expect(
      (
        await call('PATCH', '/workflows/' + id, {
          editRevision: created.body.editRevision,
          steps: [http({ 'X-LEGACY': keep })],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('PATCH', '/workflows/' + id, {
          editRevision: created.body.editRevision,
          steps: [http({ 'x-legacy': keep })],
        })
      ).status,
    ).toBe(200);
  });

  it('rejects stale edits after a metadata change and keeps the same version for identical steps', async () => {
    const steps = [http({ 'X-A': secret })];
    const created = await call('POST', '/workflows', {
      name: 'initial',
      steps,
    });
    const path = '/workflows/' + created.body.id;
    const editRevision = created.body.editRevision;
    const identical = await call('PATCH', path, { editRevision, steps });
    expect(identical.body).toMatchObject({ version: 1, editRevision });
    const renamed = await call('PATCH', path, {
      editRevision,
      name: 'renamed',
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.editRevision).not.toBe(editRevision);
    expect(
      (await call('PATCH', path, { editRevision, name: 'stale' })).status,
    ).toBe(409);
    const changedUrl = await call('PATCH', path, {
      editRevision: renamed.body.editRevision,
      steps: [{ ...http({ 'X-A': keep }), url: receiver.url('/other') }],
    });
    expect(changedUrl.status).toBe(400);
    expect((await call('GET', path)).body).toMatchObject({
      name: 'renamed',
      version: 1,
    });
  });
});
