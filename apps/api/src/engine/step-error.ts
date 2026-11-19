export class StepError extends Error {
  constructor(
    message: string,
    readonly retryable = true,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}
