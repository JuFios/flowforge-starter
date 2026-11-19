import { MAX_HTTP_BODY_BYTES } from '../workflows/definition';
import { StepError } from './step-error';

export interface StepContext {
  input: Record<string, unknown>;
  steps: Record<string, unknown>;
}

function lookup(ctx: StepContext, path: string): unknown {
  const [root, ...fields] = path.split('.');
  if (root !== 'input' && root !== 'steps') return undefined;
  let value: unknown = ctx[root];
  for (const field of fields) {
    if (
      value === null ||
      typeof value !== 'object' ||
      !Object.hasOwn(value, field)
    )
      return undefined;
    value = (value as Record<string, unknown>)[field];
  }
  return value;
}

/** Бюджет застосовується перед додаванням кожної підстановки, включно з повторними. */
export function renderTemplate(
  template: string,
  ctx: StepContext,
  maxBytes = MAX_HTTP_BODY_BYTES,
  error = 'template output is too large',
): string {
  const chunks: string[] = [];
  let bytes = 0;
  function append(part: string): void {
    bytes += Buffer.byteLength(part);
    if (bytes > maxBytes) throw new StepError(error, false);
    chunks.push(part);
  }
  let offset = 0;
  for (const match of template.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g)) {
    append(template.slice(offset, match.index));
    const value = lookup(ctx, match[1]);
    if (value !== null && value !== undefined)
      append(typeof value === 'object' ? JSON.stringify(value) : String(value));
    offset = match.index! + match[0].length;
  }
  append(template.slice(offset));
  return chunks.join('');
}
