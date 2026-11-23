import type {
  OpenAPIObject,
  OperationObject,
  SchemaObject,
} from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { request } from 'node:http';

export interface Observed {
  operation: string;
  status: number;
  headers: Headers;
  body: unknown;
}

/**
 * Перевірка OpenAPI фактичними відповідями (ТЗ 7): `send` надсилає запит і запам'ятовує відповідь
 * разом з операцією документа, `checkAgainstDocument` звіряє статус, схему тіла й заголовки.
 */
export function openApiContract(
  baseUrl: () => string,
  doc: () => OpenAPIObject,
) {
  const observed: Observed[] = [];

  /** Надсилає запит і запам'ятовує відповідь разом з операцією документа (`method /template`). */
  async function send(
    operation: string,
    path: string,
    expectedStatus: number,
    init: {
      headers?: Record<string, string>;
      body?: unknown;
      raw?: string;
    } = {},
  ): Promise<Observed> {
    const [method] = operation.split(' ');
    const url = baseUrl() + path;
    const raw =
      init.raw ??
      (init.body === undefined ? undefined : JSON.stringify(init.body));
    const headers = {
      ...(raw === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers,
    };
    const res =
      method === 'get' && raw !== undefined
        ? await getWithBody(url, raw, headers)
        : await fetch(url, {
            method: method.toUpperCase(),
            headers,
            body: raw,
          });
    expect({ operation, status: res.status }).toEqual({
      operation,
      status: expectedStatus,
    });
    const text = await res.text();
    let body: unknown = undefined;
    if (text)
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    const result = {
      operation,
      status: res.status,
      headers: res.headers,
      body,
    };
    observed.push(result);
    return result;
  }

  /** Fetch відхиляє GET із тілом до мережі, тому надсилаємо його через HTTP-клієнт Node. */
  function getWithBody(
    url: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<Response> {
    return new Promise((resolve, reject) => {
      const req = request(
        url,
        { headers: { ...headers, 'content-length': Buffer.byteLength(body) } },
        (res) => {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (value !== undefined)
              responseHeaders.set(
                name,
                Array.isArray(value) ? value.join(', ') : value,
              );
          }
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            text += chunk;
          });
          res.once('error', reject);
          res.once('end', () =>
            resolve(
              new Response(text || null, {
                status: res.statusCode,
                headers: responseHeaders,
              }),
            ),
          );
        },
      );
      req.setTimeout(5000, () =>
        req.destroy(new Error('GET body test timed out')),
      );
      req.once('error', reject);
      req.end(body);
    });
  }

  function resolve(schema: SchemaObject): SchemaObject {
    const ref = (schema as { $ref?: string }).$ref;
    if (!ref) return schema;
    const name = ref.replace('#/components/schemas/', '');
    return doc().components!.schemas![name] as SchemaObject;
  }

  /** Відхилення значення від схеми (обов'язкові поля, типи, enum, закриті об'єкти). */
  function violations(value: unknown, raw: SchemaObject, at = '$'): string[] {
    const schema = resolve(raw);
    if (value === null)
      return schema.nullable ? [] : [`${at}: null is not allowed`];
    if (schema.oneOf)
      return schema.oneOf.some(
        (s) => violations(value, s as SchemaObject, at).length === 0,
      )
        ? []
        : [`${at}: matches no alternative`];
    if (schema.enum && !schema.enum.includes(value))
      return [`${at}: ${JSON.stringify(value)} is not in the enum`];
    switch (schema.type) {
      case 'string':
        return typeof value === 'string' ? [] : [`${at}: expected a string`];
      case 'integer':
        return Number.isInteger(value) ? [] : [`${at}: expected an integer`];
      case 'number':
        return typeof value === 'number' ? [] : [`${at}: expected a number`];
      case 'boolean':
        return typeof value === 'boolean' ? [] : [`${at}: expected a boolean`];
      case 'array':
        return Array.isArray(value)
          ? value.flatMap((v, i) =>
              violations(v, schema.items as SchemaObject, `${at}[${i}]`),
            )
          : [`${at}: expected an array`];
      case 'object': {
        if (typeof value !== 'object' || Array.isArray(value))
          return [`${at}: expected an object`];
        const record = value as Record<string, unknown>;
        const props = (schema.properties ?? {}) as Record<string, SchemaObject>;
        const out = (schema.required ?? [])
          .filter((k) => !(k in record))
          .map((k) => `${at}.${k}: required`);
        for (const [k, v] of Object.entries(record)) {
          if (props[k]) out.push(...violations(v, props[k], `${at}.${k}`));
          else if (schema.additionalProperties === false)
            out.push(`${at}.${k}: not declared`);
        }
        return out;
      }
      default:
        return [];
    }
  }

  function checkAgainstDocument(o: Observed): string[] {
    const [method, path] = o.operation.split(' ');
    const op = (
      doc().paths[path] as Record<string, OperationObject> | undefined
    )?.[method];
    if (!op) return [`${o.operation}: not documented`];
    const response = op.responses[String(o.status)] as
      | {
          content?: Record<string, { schema: SchemaObject }>;
          headers?: Record<string, unknown>;
        }
      | undefined;
    if (!response) return [`${o.operation}: status ${o.status} not declared`];
    const problems: string[] = [];
    const schema = response.content?.['application/json']?.schema;
    if (schema && o.body === undefined)
      problems.push(`${o.operation} ${o.status}: body expected`);
    if (schema && o.body !== undefined)
      problems.push(
        ...violations(o.body, schema).map(
          (v) => `${o.operation} ${o.status}: ${v}`,
        ),
      );
    if (!schema && o.body !== undefined && o.status !== 204)
      problems.push(`${o.operation} ${o.status}: undeclared body`);
    for (const header of Object.keys(response.headers ?? {})) {
      if (header === 'Retry-After') {
        const error = (o.body as { error?: string } | undefined)?.error;
        if (
          (error === 'rate_limited' ||
            error === 'detail_in_progress' ||
            o.status === 503) &&
          !o.headers.get(header)
        )
          problems.push(`${o.operation} ${o.status}: missing ${header}`);
        continue;
      }
      // Заголовки ліміту частоти несе кожна відповідь під лімітом (автентифікований запит).
      if (header.startsWith('X-RateLimit-') && o.status === 401) continue;
      if (!o.headers.get(header))
        problems.push(`${o.operation} ${o.status}: missing ${header}`);
    }
    return problems;
  }

  return { observed, send, checkAgainstDocument, violations, resolve };
}
