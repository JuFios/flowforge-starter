import { type Express } from 'express';
import { buildDocument } from '../../src/openapi/document';
import { startApp, type RunningApp } from '../helpers/app';

describe('published HTTP contract', () => {
  let server: RunningApp;
  beforeAll(async () => {
    server = await startApp();
  });
  afterAll(async () => {
    await server.close();
  });
  it('documents each registered route, security boundary and successful response', () => {
    const doc = buildDocument(server.app);
    const express = server.app.getHttpAdapter().getInstance() as Express;
    const router = express._router as {
      stack: Array<{
        route?: { path: string; methods: Record<string, boolean> };
      }>;
    };
    const registered = router.stack
      .flatMap(({ route }) =>
        route && route.path !== '/*'
          ? Object.keys(route.methods).map(
              (method) => method + ' ' + route.path.replace(/:(\w+)/g, '{$1}'),
            )
          : [],
      )
      .sort();
    const documented = Object.entries(doc.paths)
      .flatMap(([path, operations]) =>
        Object.keys(operations).map((method) => method + ' ' + path),
      )
      .sort();
    expect(documented).toEqual(registered);
    expect(doc.paths['/sessions'].post?.security).toEqual([{ tenantKey: [] }]);
    expect(doc.paths['/workflows'].get?.security).toEqual([
      { tenantKey: [] },
      { browserSession: [] },
    ]);
    expect(doc.paths['/workflows/{id}/run'].post?.responses).toHaveProperty(
      '200',
    );
    expect(
      doc.paths['/tenants/me/notifications/events/{id}/redeliver'].post
        ?.responses,
    ).toHaveProperty('409');
    expect(JSON.stringify(doc.components?.schemas?.Workflow)).toContain(
      '"stored"',
    );
    expect(JSON.stringify(doc.components?.schemas?.UpdateWorkflow)).toContain(
      '"keep"',
    );
    expect(
      JSON.stringify(doc.components?.schemas?.CreateWorkflow),
    ).not.toContain('"keep"');
  });
});
