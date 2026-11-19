import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { CONTEXT_BYTES, RESULT_BYTES } from './transform-profile';
import type { StepContext } from './template';
import { StepError } from './step-error';

const invalid = () =>
  new StepError(
    'transform: expression or result exceeds the supported profile',
    false,
  );

export async function isolatedTransform(
  expr: string,
  language: string | undefined,
  ctx: StepContext,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  if (expr.length > 4096) throw invalid();
  const context = JSON.stringify(ctx);
  if (Buffer.byteLength(context) > CONTEXT_BYTES) throw invalid();
  const payload =
    '{"expr":' +
    JSON.stringify(expr) +
    (language ? ', "language":' + JSON.stringify(language) : '') +
    ',"ctx":' +
    context +
    '}';
  const child = spawn(
    process.execPath,
    [
      '--jitless',
      '--max-old-space-size=32',
      resolve(__dirname, '../../dist/engine/transform-child.js'),
    ],
    {
      env: {},
      stdio: ['pipe', 'pipe', 'ignore'],
    },
  );
  return new Promise((done, fail) => {
    let bytes = 0,
      terminated = false,
      failure: Error | undefined;
    const chunks: Buffer[] = [];
    const terminate = () => {
      terminated = true;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(terminate, 2000);
    signal?.addEventListener('abort', terminate, { once: true });
    if (signal?.aborted) terminate();
    child.once('error', () => {
      failure = new StepError('transform: could not start evaluator');
    });
    child.stdin.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code !== 'EPIPE') {
        failure = new StepError('transform: input channel failed');
        terminate();
      }
    });
    child.stdout.on('error', () => {
      failure = new StepError('transform: output channel failed');
      terminate();
    });
    child.stdout.on('data', (part: Buffer) => {
      bytes += part.length;
      if (bytes > RESULT_BYTES) terminate();
      else chunks.push(part);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', terminate);
      if (signal?.aborted) return fail(signal.reason);
      if (failure) return fail(failure);
      if (terminated || code !== 0) return fail(invalid());
      try {
        done(
          JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) as unknown,
        );
      } catch {
        fail(new StepError('transform: invalid evaluator response'));
      }
    });
    child.stdin.end(payload);
  });
}
