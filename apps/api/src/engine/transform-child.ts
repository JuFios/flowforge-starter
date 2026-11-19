import { CONTEXT_BYTES, evaluateTransform } from './transform-profile';
import type { StepContext } from './template';

async function main(): Promise<void> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const part of process.stdin) {
    const chunk = part as Buffer;
    bytes += chunk.length;
    if (bytes > CONTEXT_BYTES + 32768) throw new Error();
    chunks.push(chunk);
  }
  const { expr, language, ctx } = JSON.parse(
    Buffer.concat(chunks, bytes).toString('utf8'),
  ) as { expr: string; language?: string; ctx: StepContext };
  const result = await evaluateTransform(
    expr,
    language,
    ctx,
    Buffer.byteLength(JSON.stringify(ctx)),
  );
  process.stdout.write(result);
}
void main().catch(() => {
  process.exitCode = 2;
});
