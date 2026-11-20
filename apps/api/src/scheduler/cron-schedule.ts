import { CronExpression, parseExpression } from 'cron-parser';

/** Розклад, який не можна обчислити (невалідний вираз або таймзона, немає майбутніх моментів). */
export class InvalidScheduleError extends Error {}

const SECOND = 1_000;
const HOUR = 3_600 * SECOND;
const DAY = 24 * HOUR;
/** Найбільший зсув годинника при переході (Antarctica/Troll — 2 год) із запасом. */
const MAX_SHIFT = 3 * HOUR;
/** Крок пошуку переходів: два переходи однієї зони ніколи не бувають ближче за 12 год. */
const TRANSITION_STEP = 12 * HOUR;
/** Найдальший горизонт пошуку наступного моменту (рідкісні розклади на кшталт 29 лютого). */
const HORIZON = 10 * 366 * DAY;
const MAX_FORMATTERS = 128;

/** Ім'я зони IANA (зокрема аліаси на кшталт `US/Eastern`), а не зміщення чи `local`. */
const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  const key = timeZone.toLowerCase();
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    if (formatters.size >= MAX_FORMATTERS) {
      const oldest = formatters.keys().next();
      if (!oldest.done) formatters.delete(oldest.value);
    }
    formatters.set(key, f);
  }
  return f;
}

/** Чи `timeZone` — ім'я зони IANA, яке знає ICU цього процесу. */
export function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (
    typeof timeZone !== 'string' ||
    timeZone.length > 64 ||
    !ZONE_NAME.test(timeZone)
  )
    return false;
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Зміщення місцевого часу зони від UTC у мс у момент `instant` (з точністю до секунди). */
export function zoneOffset(timeZone: string, instant: number): number {
  const at = Math.floor(instant / SECOND) * SECOND;
  const parts: Record<string, number> = {};
  for (const { type, value } of formatter(timeZone).formatToParts(at))
    if (type !== 'literal') parts[type] = Number(value);
  const local = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return local - at;
}

/**
 * Розклад cron у таймзоні — детермінована множина моментів, незалежна від того, звідки почати
 * обчислення (docs/architecture.md 3.3.8, «Часові пояси й DST»).
 *
 * `cron-parser` перебирає **наївний** місцевий час у режимі UTC (там немає переходів, тож `next()`
 * — чиста функція). Наївний момент відображається на реальний за правилом RFC 5545 §3.3.5:
 * - час, якого немає (весняний розрив), береться зі зміщенням до розриву, тобто зсувається вперед
 *   на розмір розриву (03:30 при переході 03:00→04:00 стає 04:30);
 * - час, що повторюється (осіння година), — перше проходження; якщо поле годин охоплює всі 24
 *   години (розклад «щоп'ять хвилин»), то обидва, щоб реальний інтервал не мав «дірки».
 * Однакові реальні моменти зливаються в один (ідентичність спрацювання — UTC-момент).
 */
export class CronSchedule {
  private readonly naive: CronExpression;
  private readonly everyHour: boolean;

  private constructor(
    expression: string,
    readonly timeZone: string,
  ) {
    this.naive = parseExpression(expression, {
      tz: 'UTC',
      currentDate: new Date(0),
    });
    this.everyHour = this.naive.fields.hour.length === 24;
  }

  /**
   * Розбирає й перевіряє розклад: вираз має п'ять або шість полів (або `@hourly` тощо), зона —
   * IANA, і в межах горизонту є хоча б один майбутній момент.
   */
  static parse(
    expression: unknown,
    timeZone: unknown,
    from = Date.now(),
  ): CronSchedule {
    if (typeof expression !== 'string' || expression.trim() === '')
      throw new InvalidScheduleError('cron expression is empty');
    if (expression.length > 100)
      throw new InvalidScheduleError('cron expression is too long');
    const source = expression.trim();
    const fields = source.split(/\s+/).length;
    if (
      fields !== 5 &&
      fields !== 6 &&
      !/^@(yearly|monthly|weekly|daily|hourly)$/.test(source)
    )
      throw new InvalidScheduleError(
        'cron requires five or six fields or a supported alias',
      );
    if (!isValidTimeZone(timeZone))
      throw new InvalidScheduleError('timezone is not a known IANA zone');
    let schedule: CronSchedule;
    try {
      schedule = new CronSchedule(source, timeZone);
    } catch {
      throw new InvalidScheduleError('cron expression is invalid');
    }
    schedule.next(new Date(from));
    return schedule;
  }

  /** Перший момент розкладу строго після `after`. */
  next(after: Date): Date {
    try {
      return new Date(this.nextMs(after.getTime()));
    } catch (err) {
      // cron-parser кидає звичайний Error, коли не знаходить дати (напр., 30 лютого).
      if (err instanceof InvalidScheduleError) throw err;
      throw new InvalidScheduleError('schedule has no upcoming occurrence');
    }
  }

  /** Межа монотонного предиката next(t) <= end дає останнє спрацювання з тими ж правилами DST. */
  lastAtOrBefore(atOrBefore: Date, after: Date): Date | undefined {
    const end = Math.floor(atOrBefore.getTime() / SECOND);
    let lo = Math.floor(after.getTime() / SECOND);
    if (lo >= end) return undefined;
    if (this.next(new Date((end - 1) * SECOND)).getTime() === end * SECOND)
      return new Date(end * SECOND);
    const first = this.next(new Date(lo * SECOND)).getTime() / SECOND;
    if (first > end) return undefined;
    lo = first;
    let hi = end;
    while (lo < hi) {
      const mid = lo + Math.floor((hi - lo) / 2);
      const next = this.next(new Date(mid * SECOND)).getTime() / SECOND;
      if (next <= end) lo = next;
      else hi = mid;
    }
    return new Date(lo * SECOND);
  }

  private offset(instant: number): number {
    return zoneOffset(this.timeZone, instant);
  }

  /** Перший наївний момент розкладу строго після наївного `n`. */
  private naiveAfter(n: number): number {
    this.naive.reset(new Date(n));
    return this.naive.next().toDate().getTime();
  }

  /** Перший перехід зони в (`from`, `to`]: момент, з якого діє нове зміщення, або undefined. */
  private transition(from: number, to: number): number | undefined {
    let lo = from;
    const base = this.offset(from);
    for (;;) {
      const hi = Math.min(lo + TRANSITION_STEP, to);
      if (this.offset(hi) !== base) {
        // Бінарний пошук першої секунди з іншим зміщенням.
        let a = Math.floor(lo / SECOND),
          b = Math.floor(hi / SECOND);
        while (b - a > 1) {
          const mid = Math.floor((a + b) / 2);
          if (this.offset(mid * SECOND) === base) a = mid;
          else b = mid;
        }
        return b * SECOND;
      }
      if (hi >= to) return undefined;
      lo = hi;
    }
  }

  private nextMs(after: number): number {
    const limit = after + HORIZON;
    let best: number | undefined;
    // Наївна нижня межа звичайних моментів поточного відрізка (виключно).
    let naiveFloor = after + this.offset(after);
    // Перехід щойно перед `after`: його розрив чи повтор впливають на наступні моменти.
    const back = this.transition(after - MAX_SHIFT, after);
    if (back !== undefined) {
      const pre = this.offset(back - SECOND),
        post = this.offset(back);
      if (post > pre) {
        // Розрив: моменти з наївним часом у [back+pre, back+post) зсунуто вперед, тож частина з
        // них може бути ще попереду `after`.
        const shifted = this.naiveAfter(Math.max(after + pre, back + pre - 1));
        if (shifted < back + post) best = shifted - pre;
      } else if (!this.everyHour && after < back + (pre - post)) {
        // Повтор: друге проходження повтореної години для фіксованих годин не діє.
        naiveFloor = Math.max(naiveFloor, back + pre - 1);
      }
    }
    let lower = after;
    for (;;) {
      if (lower > limit)
        throw new InvalidScheduleError('schedule has no upcoming occurrence');
      const offset = this.offset(lower);
      const candidate = this.naiveAfter(naiveFloor) - offset;
      // Кандидат зсунутого розриву вже раніше за будь-який момент поточного відрізка.
      if (best !== undefined && candidate >= best) return best;
      const at = this.transition(lower, candidate);
      if (at === undefined)
        return best === undefined ? candidate : Math.min(best, candidate);
      const pre = offset,
        post = this.offset(at);
      if (post > pre) {
        const shifted = this.naiveAfter(at + pre - 1);
        if (shifted < at + post)
          best =
            best === undefined ? shifted - pre : Math.min(best, shifted - pre);
        naiveFloor = at + post - 1;
      } else {
        naiveFloor = (this.everyHour ? at + post : at + pre) - 1;
      }
      if (best !== undefined && best < at) return best;
      lower = at;
    }
  }
}
