import { MissedRunPolicy } from '../entities';
import { CronSchedule, InvalidScheduleError } from './cron-schedule';

/**
 * Що робити з найранішим необробленим моментом розкладу (README 3.3.8, політика пропущених
 * запусків).
 *
 * Інваріант: момент пропущений тоді й лише тоді, коли він строго раніший за `threshold`
 * (`now − SCHEDULER_MISFIRE_GRACE_MS`) за **тим самим** показом годинника, яким виявлено пропуск.
 * Момент рівно на межі вчасний. Новий курсор — завжди момент розкладу, тож курсор не проходить
 * повз жоден вчасний момент, який ще не оброблено.
 */
export type MissedDecision =
  /**
   * Створити виконання для `at` і пересунути курсор на `cursor`. Вчасний момент і `run_all` —
   * сам момент; `run_once` (`collapsed`) — останній пропущений, решта пропущених відкидається.
   * `skipped` — пропущені моменти, які `skip` відкинув у тій самій транзакції перед `at`.
   */
  | {
      kind: 'fire';
      at: Date;
      cursor: Date;
      collapsed: boolean;
      skipped?: { first: Date; last: Date };
    }
  /** `skip` без вчасного моменту до `now`: відкинути пропущені до `lastMissed` включно. */
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
  now: Date,
  policy: MissedRunPolicy,
): MissedDecision {
  if (next.getTime() >= threshold.getTime() || policy === 'run_all')
    return { kind: 'fire', at: next, cursor: next, collapsed: false };
  // Останній момент строго до межі: момент рівно на `threshold` вчасний і в пропущені не йде.
  // `next` сам пропущений, тож результат існує; `?? next` — лише для типу.
  const lastMissed =
    schedule.lastAtOrBefore(new Date(threshold.getTime() - 1), cursor) ?? next;
  if (policy === 'run_once')
    return {
      kind: 'fire',
      at: lastMissed,
      cursor: lastMissed,
      collapsed: true,
    };
  // skip: перший вчасний момент запускається в тій самій транзакції. Окрема транзакція заново
  // прочитала б годинник, і момент на межі за мілісекунду став би пропущеним.
  const onTime = following(schedule, lastMissed);
  if (onTime && onTime.getTime() <= now.getTime())
    return {
      kind: 'fire',
      at: onTime,
      cursor: onTime,
      collapsed: false,
      skipped: { first: next, last: lastMissed },
    };
  return { kind: 'skip', lastMissed };
}

/** Наступний момент або undefined, якщо в межах горизонту генератора моментів більше немає. */
function following(schedule: CronSchedule, after: Date): Date | undefined {
  try {
    return schedule.next(after);
  } catch (err) {
    if (err instanceof InvalidScheduleError) return undefined;
    throw err;
  }
}
