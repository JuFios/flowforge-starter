import { Workflow } from '../entities';

/** Публічне представлення. Сервіси виконання працюють з оригіналом та його знімками. */
export function workflowView(workflow: Workflow) {
  return {
    ...workflow,
    steps: workflow.steps.map((step) =>
      step.type === 'http' && step.headers
        ? {
            ...step,
            headers: Object.fromEntries(
              Object.keys(step.headers).map((name) => [name, { stored: true }]),
            ),
          }
        : step,
    ),
  };
}
