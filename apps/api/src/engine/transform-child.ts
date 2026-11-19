import {
  CONTEXT_BYTES,
  evaluateTransform,
  EXIT_EVALUATION,
  EXIT_LIMIT,
  TransformEvaluationError,
  TransformLimitError,
} from './transform-profile';
import type { StepContext } from './template';

async function main(): Promise<void> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const part of process.stdin) {
    const chunk = part as Buffer;
    bytes += chunk.length;
    if (bytes > CONTEXT_BYTES + 32768) throw new TransformLimitError();
    chunks.push(chunk);
  }
  const { expr, language, ctx } = JSON.parse(
    Buffer.concat(chunks, bytes).toString('utf8'),
  ) as { expr: string; language?: string; ctx: StepContext };
  process.stdout.write(await evaluateTransform(expr, language, ctx));
}

void main().catch((error: unknown) => {
  // Код виходу — єдине, що процес повідомляє про помилку: текст може містити дані контексту.
  process.exitCode =
    error instanceof TransformEvaluationError
      ? EXIT_EVALUATION
      : error instanceof TransformLimitError
        ? EXIT_LIMIT
        : 2;
});
