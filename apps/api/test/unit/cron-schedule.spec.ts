import {
  CronSchedule,
  InvalidScheduleError,
  isValidTimeZone,
} from '../../src/scheduler/cron-schedule';

const iso = (s: string) => new Date(s).getTime();

/** Перші `n` моментів після `from`, щоразу починаючи обчислення заново з попереднього моменту. */
function chain(cron: string, zone: string, from: string, n: number): string[] {
  const schedule = CronSchedule.parse(cron, zone, iso(from));
  const out: string[] = [];
  let at = new Date(from);
  for (let i = 0; i < n; i++) {
    at = schedule.next(at);
    out.push(at.toISOString().replace('.000', ''));
  }
  return out;
}

describe('cron schedule in a timezone', () => {
  // Очікування визначено заздалегідь за правилами зон (tzdata), а не цією ж бібліотекою.
  // Europe/Kyiv: 2026-03-29 03:00 EET → 04:00 EEST (01:00Z); 2026-10-25 04:00 EEST → 03:00 EET (01:00Z).
  // America/New_York: 2026-03-08 02:00 EST → 03:00 EDT (07:00Z); 2026-11-01 02:00 EDT → 01:00 EST (06:00Z).
  it.each([
    [
      'a fixed time inside the spring gap moves forward by the gap',
      '30 3 * * *',
      'Europe/Kyiv',
      '2026-03-27T12:00:00Z',
      [
        '2026-03-28T01:30:00Z', // 03:30 EET
        '2026-03-29T01:30:00Z', // 03:30 не існує → 04:30 EEST
        '2026-03-30T00:30:00Z', // 03:30 EEST
      ],
    ],
    [
      'a fixed time inside the repeated autumn hour fires once, on the first pass',
      '30 3 * * *',
      'Europe/Kyiv',
      '2026-10-24T12:00:00Z',
      [
        '2026-10-25T00:30:00Z', // 03:30 EEST, друге проходження (01:30Z) — ні
        '2026-10-26T01:30:00Z', // 03:30 EET
      ],
    ],
    [
      'every slot of a fixed hour inside the spring gap is kept, shifted forward',
      '*/20 3 * * *',
      'Europe/Kyiv',
      '2026-03-28T12:00:00Z',
      [
        '2026-03-29T01:00:00Z',
        '2026-03-29T01:20:00Z',
        '2026-03-29T01:40:00Z',
        '2026-03-30T00:00:00Z',
      ],
    ],
    [
      'an every-hour schedule fires on both passes of the repeated hour',
      '*/30 * * * *',
      'Europe/Kyiv',
      '2026-10-25T00:00:00Z',
      [
        '2026-10-25T00:30:00Z', // 03:30 EEST
        '2026-10-25T01:00:00Z', // 03:00 EET
        '2026-10-25T01:30:00Z', // 03:30 EET
        '2026-10-25T02:00:00Z', // 04:00 EET
      ],
    ],
    [
      'an every-hour schedule has no hole and no duplicate across the spring gap',
      '*/30 * * * *',
      'Europe/Kyiv',
      '2026-03-29T00:00:00Z',
      [
        '2026-03-29T00:30:00Z', // 02:30 EET
        '2026-03-29T01:00:00Z', // 04:00 EEST
        '2026-03-29T01:30:00Z', // 04:30 EEST
        '2026-03-29T02:00:00Z',
      ],
    ],
    [
      'a fixed time in the New York spring gap moves forward',
      '30 2 * * *',
      'America/New_York',
      '2026-03-07T12:00:00Z',
      ['2026-03-08T07:30:00Z', '2026-03-09T06:30:00Z'],
    ],
    [
      'a fixed time in the New York repeated hour fires once',
      '30 1 * * *',
      'America/New_York',
      '2026-10-31T12:00:00Z',
      ['2026-11-01T05:30:00Z', '2026-11-02T06:30:00Z'],
    ],
    [
      'an hourly schedule follows real time through the New York repeated hour',
      '0 * * * *',
      'America/New_York',
      '2026-11-01T04:30:00Z',
      ['2026-11-01T05:00:00Z', '2026-11-01T06:00:00Z', '2026-11-01T07:00:00Z'],
    ],
    [
      'a half-hour offset zone',
      '0 0 * * *',
      'Asia/Kolkata',
      '2026-01-01T00:00:00Z',
      ['2026-01-01T18:30:00Z', '2026-01-02T18:30:00Z'],
    ],
    [
      'UTC',
      '0 9 * * 1-5',
      'UTC',
      '2026-11-20T10:00:00Z', // п'ятниця
      ['2026-11-23T09:00:00Z', '2026-11-24T09:00:00Z'],
    ],
  ])('%s', (_case, cron, zone, from, expected) => {
    expect(chain(cron, zone, from, expected.length)).toEqual(expected);
  });

  it('does not repeat the autumn hour when resuming from inside its second pass', () => {
    const s = CronSchedule.parse('30 3 * * *', 'Europe/Kyiv');
    // 01:10Z — 03:10 EET, друге проходження години: 03:30 цього дня вже було о 00:30Z.
    expect(s.next(new Date('2026-10-25T01:10:00Z')).toISOString()).toBe(
      '2026-10-26T01:30:00.000Z',
    );
  });

  it('keeps the shifted spring slots when resuming from inside the gap', () => {
    const s = CronSchedule.parse('*/20 3 * * *', 'Europe/Kyiv');
    expect(s.next(new Date('2026-03-29T01:00:00Z')).toISOString()).toBe(
      '2026-03-29T01:20:00.000Z',
    );
  });

  it('finds the latest occurrence in a window without scanning the whole gap', () => {
    const s = CronSchedule.parse('* * * * * *', 'Europe/Kyiv');
    const started = performance.now();
    const last = s.lastAtOrBefore(
      new Date('2026-11-19T10:00:00.500Z'),
      new Date('2026-11-12T10:00:00Z'), // тиждень секундних моментів
    );
    expect(last?.toISOString()).toBe('2026-11-19T10:00:00.000Z');
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(
      CronSchedule.parse('0 0 1 1 *', 'UTC').lastAtOrBefore(
        new Date('2026-06-01T00:00:00Z'),
        new Date('2026-01-01T00:00:00Z'),
      ),
    ).toBeUndefined();
    expect(
      CronSchedule.parse('0 0 1 1 *', 'UTC')
        .lastAtOrBefore(
          new Date('2026-06-01T00:00:00Z'),
          new Date('2025-12-31T00:00:00Z'),
        )
        ?.toISOString(),
    ).toBe('2026-01-01T00:00:00.000Z');
  });

  it.each([
    ['', 'UTC'],
    ['   ', 'UTC'],
    ['0 0 31 2 *', 'UTC'],
    ['61 * * * *', 'UTC'],
    ['0 0 0 * * * *', 'UTC'],
    ['0 9 * * *', 'Mars/Olympus'],
    ['0 9 * * *', '+03:00'],
    ['0 9 * * *', 'UTC+3'],
    ['0 9 * * *', 'local'],
    ['0 9 * * *', 'system'],
    ['0 9 * * *', ''],
  ])('rejects cron %j in zone %j', (cron, zone) => {
    expect(() => CronSchedule.parse(cron, zone)).toThrow(InvalidScheduleError);
  });

  it.each(['UTC', 'Etc/UTC', 'Europe/Kyiv', 'Europe/Kiev', 'US/Eastern'])(
    'accepts the zone %s',
    (zone) => expect(isValidTimeZone(zone)).toBe(true),
  );
});

/**
 * Незалежний еталон для простих розкладів `хвилини години * * *`: перебирає кожну хвилину вікна,
 * читає місцевий час через Intl і застосовує те саме правило словами README — без cron-parser і
 * без коду генератора.
 */
function reference(
  minutes: number[],
  hours: number[] | 'all',
  zone: string,
  start: number,
  end: number,
): number[] {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const wall = (u: number) => {
    const p: Record<string, string> = {};
    for (const x of f.formatToParts(u)) p[x.type] = x.value;
    return {
      key: `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`,
      naive: Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute),
      hour: +p.hour,
      minute: +p.minute,
    };
  };
  const matches = (hour: number, minute: number) =>
    minutes.includes(minute) && (hours === 'all' || hours.includes(hour));
  const result = new Set<number>();
  const seen = new Map<number, number>(); // наївний час → перший момент
  let lastNaive = -Infinity,
    lastOffset = 0;
  for (let u = start; u <= end; u += 60_000) {
    const w = wall(u);
    if (w.naive > lastNaive + 60_000 && lastNaive !== -Infinity) {
      // Розрив: наївні хвилини, яких немає, — зі зміщенням до розриву.
      for (let n = lastNaive + 60_000; n < w.naive; n += 60_000) {
        const d = new Date(n);
        if (matches(d.getUTCHours(), d.getUTCMinutes()))
          result.add(n - lastOffset);
      }
    }
    if (matches(w.hour, w.minute)) {
      const repeated = seen.has(w.naive);
      if (!repeated || hours === 'all') result.add(u);
    }
    if (!seen.has(w.naive)) seen.set(w.naive, u);
    lastNaive = Math.max(lastNaive, w.naive);
    lastOffset = w.naive - u;
  }
  return [...result].sort((a, b) => a - b);
}

it('reuses formatters across case variants and evicts old zones', () => {
  const make = jest.spyOn(Intl, 'DateTimeFormat');
  try {
    expect(isValidTimeZone('Pacific/Fakaofo')).toBe(true);
    const before = make.mock.calls.length;
    expect(isValidTimeZone('pACIFIC/fAKAOFO')).toBe(true);
    expect(make.mock.calls).toHaveLength(before);
    const zones = (
      Intl as typeof Intl & { supportedValuesOf(key: string): string[] }
    ).supportedValuesOf('timeZone');
    for (const zone of zones
      .filter((z) => z !== 'Pacific/Fakaofo')
      .slice(0, 150))
      expect(isValidTimeZone(zone)).toBe(true);
    const filled = make.mock.calls.length;
    expect(isValidTimeZone('Pacific/Fakaofo')).toBe(true);
    expect(make.mock.calls).toHaveLength(filled + 1);
  } finally {
    make.mockRestore();
  }
});

it('finds the last seasonal second after a dense month with bounded work', () => {
  const start = new Date('2026-01-01T00:00:00Z');
  const schedule = CronSchedule.parse('* * * * 1 *', 'UTC', start.getTime());
  const original = schedule.next.bind(schedule);
  const lookup = jest.spyOn(schedule, 'next').mockImplementation((at) => {
    if (lookup.mock.calls.length > 40)
      throw new Error('too many successor queries');
    return original(at);
  });
  expect(
    schedule
      .lastAtOrBefore(new Date('2026-02-15T00:00:00Z'), start)
      ?.toISOString(),
  ).toBe('2026-01-31T23:59:59.000Z');
});

describe('cron schedule against an independent reference around transitions', () => {
  it.each([
    ['30 3 * * *', 'Europe/Kyiv', '2026-03-29T01:00:00Z', [30], [3]],
    ['30 3 * * *', 'Europe/Kyiv', '2026-10-25T01:00:00Z', [30], [3]],
    ['*/20 3 * * *', 'Europe/Kyiv', '2026-03-29T01:00:00Z', [0, 20, 40], [3]],
    ['*/20 3 * * *', 'Europe/Kyiv', '2026-10-25T01:00:00Z', [0, 20, 40], [3]],
    ['*/30 * * * *', 'Europe/Kyiv', '2026-10-25T01:00:00Z', [0, 30], 'all'],
    ['*/30 * * * *', 'Europe/Kyiv', '2026-03-29T01:00:00Z', [0, 30], 'all'],
    ['15 1,2 * * *', 'America/New_York', '2026-11-01T06:00:00Z', [15], [1, 2]],
    ['15 1,2 * * *', 'America/New_York', '2026-03-08T07:00:00Z', [15], [1, 2]],
    ['45 1 * * *', 'Australia/Lord_Howe', '2026-04-04T15:00:00Z', [45], [1]],
    ['45 2 * * *', 'Australia/Lord_Howe', '2026-10-03T15:30:00Z', [45], [2]],
  ] as const)(
    '%s in %s around %s: the same occurrences from every starting point',
    (cron, zone, transition, minutes, hours) => {
      const t = iso(transition);
      const start = t - 30 * 3_600_000,
        end = t + 30 * 3_600_000;
      const expected = reference(
        [...minutes],
        hours === 'all' ? 'all' : [...hours],
        zone,
        start,
        end,
      );
      expect(expected.length).toBeGreaterThan(1);
      const s = CronSchedule.parse(cron, zone, start);
      for (const offset of [-3600000, -1, 0, 1800000, 3600000]) {
        const end = t + offset;
        const last = expected.filter((at) => at > start && at <= end).pop();
        expect(
          s.lastAtOrBefore(new Date(end), new Date(start))?.getTime(),
        ).toBe(last);
      }
      // Старт із кожної хвилини (і з половини хвилини) в межах ±6 год від переходу.
      for (
        let from = t - 6 * 3_600_000;
        from < t + 6 * 3_600_000;
        from += 30_000
      ) {
        const want = expected.find((x) => x > from);
        if (want === undefined || want > end - 3_600_000) continue;
        expect([from, s.next(new Date(from)).getTime()]).toEqual([from, want]);
      }
    },
  );
});
