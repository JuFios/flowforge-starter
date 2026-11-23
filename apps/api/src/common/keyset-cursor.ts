import { BadRequestException } from '@nestjs/common';
import { Transform } from 'class-transformer';

/**
 * Курсор keyset-сторінки за `(createdAt, id)` — спільний для списків workflow, виконань і подій
 * сповіщень. Момент — текст із точністю Postgres (мікросекунди: JS `Date` їх відкидає, і рядки з
 * однієї мілісекунди випадали б зі сторінок), base64url. Обов'язкова область (`scope`) фіксує
 * список і фільтр, з якими курсор видано: курсор іншого списку чи з іншим фільтром — 400, а не
 * тиха сторінка іншого набору. Області списків не перетинаються (`*_CURSOR_SCOPE` нижче).
 */

/** SQL-вираз тексту моменту для курсора: UTC, мікросекунди, як очікує decodeKeysetCursor. */
export function cursorAtSql(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** Область курсора списку workflow (фільтрів немає). */
export const WORKFLOWS_CURSOR_SCOPE = 'workflows';

/** Область курсора списку подій сповіщень: префікс і фільтр за статусом. */
export function eventsCursorScope(status: string | undefined): string {
  return `events:${status ?? ''}`;
}

/**
 * Область курсора списку виконань — `<status>:<workflowId>`, формат до PR 10 збережено, тож видані
 * курсори переживають оновлення. Вона не збігається з іншими: статус виконання ніколи не
 * `events`, а `workflows` не містить двокрапки.
 */
export function executionsCursorScope(
  status: string | undefined,
  workflowId: string | undefined,
): string {
  return `${status ?? ''}:${workflowId ?? ''}`;
}

/** Найдовший курсор, який має сенс розбирати (момент, UUID, область). */
export const MAX_CURSOR_LENGTH = 200;

const SCOPE = /^[A-Za-z0-9=;:._-]{0,80}$/;
const POSITION =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\|([A-Za-z0-9=;:._-]{0,80}))?$/;

export interface KeysetPosition {
  createdAt: string;
  id: string;
}

export function encodeKeysetCursor(
  row: { cursorAt: string; id: string },
  scope: string,
): string {
  if (!SCOPE.test(scope))
    throw new Error('cursor scope has unsupported characters');
  const text = `${row.cursorAt}|${row.id}|${scope}`;
  return Buffer.from(text, 'utf8').toString('base64url');
}

/**
 * Розбирає курсор і перевіряє календарну коректність моменту (30 лютого правильної форми інакше
 * дійшло б до `timestamptz` і дало 500). `scope` має збігатися з тим, з яким курсор видано.
 */
export function decodeKeysetCursor(raw: string, scope: string): KeysetPosition {
  if (raw.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(raw))
    throw new BadRequestException(['cursor is invalid']);
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  const match = POSITION.exec(text);
  const time = match ? Date.parse(match[1]) : NaN;
  if (
    !match ||
    !Number.isFinite(time) ||
    match[1].startsWith('0000-') ||
    new Date(time).toISOString().slice(0, 23) !== match[1].slice(0, 23)
  )
    throw new BadRequestException(['cursor is invalid']);
  // Курсор без області (виданий до PR 10) не знає свого списку: відмова, як і чужому.
  if (match[3] !== scope)
    throw new BadRequestException(['cursor does not match the filter']);
  return { createdAt: match[1], id: match[2] };
}

/**
 * Ціле число з рядка запиту: лише десяткові цифри без знаку, нулів попереду й експоненти.
 * `abc`, `1.5`, `-1`, `0x10`, `1e2`, порожнє значення й повторений параметр (масив) стають NaN,
 * і `@IsInt` відхиляє їх з 400.
 */
export function QueryInt(): PropertyDecorator {
  return Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && /^[1-9]\d{0,8}$/.test(value)
      ? Number(value)
      : value === undefined
        ? undefined
        : NaN,
  );
}

/** Сторінка списку: елементи й курсор наступної сторінки (null — це остання). */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Прибирає службовий `cursorAt` з рядків і будує сторінку з запиту з `LIMIT limit + 1`. */
export function toPage<T extends { cursorAt: string; id: string }>(
  rows: T[],
  limit: number,
  scope: string,
): Page<Omit<T, 'cursorAt'>> {
  const page = rows.slice(0, limit);
  return {
    items: page.map(({ cursorAt, ...item }) => {
      void cursorAt;
      return item;
    }),
    nextCursor:
      rows.length > limit
        ? encodeKeysetCursor(page[page.length - 1], scope)
        : null,
  };
}
