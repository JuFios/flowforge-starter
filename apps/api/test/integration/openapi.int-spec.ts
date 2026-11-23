import type {
  OperationObject,
  ReferenceObject,
  SchemaObject,
} from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
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
  it('groups every operation under one declared tag, gives every request body an example and describes every field', () => {
    const doc = buildDocument(server.app);
    const declared = (doc.tags ?? []).map((t) => t.name);
    const problems: string[] = [];
    for (const tag of doc.tags ?? [])
      if (!tag.description) problems.push(`tag ${tag.name}: no description`);
    const used = new Set<string>();
    /** Поля без опису: властивості об'єктів, елементи масивів і варіанти, крім $ref. */
    const undescribed = (
      schema: SchemaObject | ReferenceObject | undefined,
      at: string,
    ): string[] => {
      if (!schema || '$ref' in schema) return [];
      const out: string[] = [];
      for (const [name, prop] of Object.entries(schema.properties ?? {})) {
        if (!('$ref' in prop) && !prop.description) out.push(`${at}.${name}`);
        out.push(...undescribed(prop, `${at}.${name}`));
      }
      if (schema.items) out.push(...undescribed(schema.items, `${at}[]`));
      for (const [i, variant] of (schema.oneOf ?? []).entries())
        out.push(...undescribed(variant, `${at}|${i}`));
      if (
        schema.additionalProperties &&
        typeof schema.additionalProperties === 'object'
      )
        out.push(...undescribed(schema.additionalProperties, `${at}.*`));
      return out;
    };
    for (const [name, schema] of Object.entries(doc.components?.schemas ?? {}))
      problems.push(...undescribed(schema, name).map((f) => `field ${f}`));
    for (const [path, item] of Object.entries(doc.paths))
      for (const [method, op] of Object.entries(
        item as Record<string, OperationObject>,
      )) {
        const operation = `${method} ${path}`;
        if (op.tags?.length !== 1 || !declared.includes(op.tags[0]))
          problems.push(`${operation}: tags ${JSON.stringify(op.tags)}`);
        else used.add(op.tags[0]);
        const body = op.requestBody as
          { content: Record<string, { example?: unknown }> } | undefined;
        if (body && body.content['application/json']?.example === undefined)
          problems.push(`${operation}: request body without an example`);
        for (const [code, response] of Object.entries(op.responses)) {
          const res = response as {
            content?: Record<string, { schema: SchemaObject }>;
            headers?: Record<string, { description?: string }>;
          };
          problems.push(
            ...undescribed(
              res.content?.['application/json']?.schema,
              `${operation} ${code}`,
            ).map((f) => `field ${f}`),
          );
          for (const [header, value] of Object.entries(res.headers ?? {}))
            if (!value.description)
              problems.push(`${operation} ${code}: header ${header}`);
        }
      }
    for (const tag of declared)
      if (!used.has(tag)) problems.push(`tag ${tag}: no operations`);
    expect(problems).toEqual([]);
  });
});
