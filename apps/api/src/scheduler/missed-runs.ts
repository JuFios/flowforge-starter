import { MissedRunPolicy } from '../entities';
import { CronSchedule } from './cron-schedule';

/**
 * Що робити з найранішим необробленим моментом розкладу (README 3.3.8, політика пропущених
 * запусків).
 *
 * Інваріант: момент пропущений тоді й лише тоді, коли він строго раніший за `threshold`
 * (`now − SCHEDULER_MISFIRE_GRACE_MS`). Момент рівно на межі вчасний. Новий курсор — завжди
 * момент розкладу, не пізніший за останній пропущений, тож курсор не проходить повз жоден
 * вчасний момент, який ще не оброблено.
 */
export type MissedDecision =
  /**
   * Створити виконання для `at` і пересунути курсор на `cursor`. Вчасний момент і `run_all` —
   * сам момент; `run_once` (`collapsed`) — останній пропущений, решта пропущених відкидається.
   */
  | { kind: 'fire'; at: Date; cursor: Date; collapsed: boolean }
  /** `skip`: відкинути всі пропущені моменти до `lastMissed` включно, без виконання. */
  | { kind: 'skip'; lastMissed: Date };

/**
 * Рішення для моменту `next` — першого моменту розкладу після `cursor`. Чиста функція: залежить
 * лише від аргументів, тож межу допуску можна перевірити з фіксованим годинником.
 */
export function decideMissed(
  schedule: CronSchedule,
  cursor: Date,
  next: Date,
  threshold: Date,
  policy: MissedRunPolicy,
): MissedDecision {
  if (next.getTime() >= threshold.getTime() || policy === 'run_all')
    return { kind: 'fire', at: next, cursor: next, collapsed: false };
  // Останній момент строго до межі: момент рівно на `threshold` вчасний і в пропущені не йде.
  // `next` сам пропущений, тож результат існує; `?? next` — лише для типу.
  const lastMissed =
    schedule.lastAtOrBefore(new Date(threshold.getTime() - 1), cursor) ?? next;
  return policy === 'skip'
    ? { kind: 'skip', lastMissed }
    : { kind: 'fire', at: lastMissed, cursor: lastMissed, collapsed: true };
}
