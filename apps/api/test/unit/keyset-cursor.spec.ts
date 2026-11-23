import { BadRequestException } from '@nestjs/common';
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  eventsCursorScope,
  executionsCursorScope,
  WORKFLOWS_CURSOR_SCOPE,
} from '../../src/common/keyset-cursor';
import { EXECUTION_STATUSES } from '../../src/executions/list-executions.query';
import { EVENT_STATUSES } from '../../src/notifications/notifications.dto';

const ROW = {
  cursorAt: '2026-03-01T10:00:00.123456Z',
  id: '00000000-0000-4000-8000-000000000001',
};
const WORKFLOW_ID = '00000000-0000-4000-8000-000000000002';

/** Повідомлення 400, з яким відмовлено (те саме тіло, що отримає клієнт). */
function rejection(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    if (err instanceof BadRequestException)
      return (err.getResponse() as { message: unknown }).message;
    throw err;
  }
  throw new Error('expected a 400');
}

/** Кожна область кожного списку: курсор однієї не повинен підходити жодній іншій. */
function everyScope(): string[] {
  const executions = [undefined, ...EXECUTION_STATUSES].flatMap((status) =>
    [undefined, WORKFLOW_ID].map((workflowId) =>
      executionsCursorScope(status, workflowId),
    ),
  );
  const events = [undefined, ...EVENT_STATUSES].map(eventsCursorScope);
  return [WORKFLOWS_CURSOR_SCOPE, ...executions, ...events];
}

describe('keyset cursor scope', () => {
  it('gives every list and filter its own scope', () => {
    const scopes = everyScope();
    expect(new Set(scopes).size).toBe(scopes.length);
  });

  it('accepts a cursor only with the scope it was issued for', () => {
    const scopes = everyScope();
    for (const issued of scopes) {
      const cursor = encodeKeysetCursor(ROW, issued);
      for (const other of scopes)
        if (other === issued)
          expect(decodeKeysetCursor(cursor, other)).toEqual({
            createdAt: ROW.cursorAt,
            id: ROW.id,
          });
        else
          expect(() => decodeKeysetCursor(cursor, other)).toThrow(
            BadRequestException,
          );
    }
  });

  it('rejects a cursor without a scope', () => {
    const legacy = Buffer.from(`${ROW.cursorAt}|${ROW.id}`).toString(
      'base64url',
    );
    for (const scope of everyScope())
      expect(rejection(() => decodeKeysetCursor(legacy, scope))).toEqual([
        'cursor does not match the filter',
      ]);
  });
});
