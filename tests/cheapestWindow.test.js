const { findCheapestWindow, findUpcomingWindow, hasCompleteDay, localDate } = require('../utils/cheapestWindow');

const MINUTE = 60_000;
const TIMEZONE = 'Europe/Amsterdam';
// 2 Nov 2026 runs from 23:00Z the day before, in CET.
const DAY_START = Date.parse('2026-11-01T23:00:00Z');

function quarters(count = 96, priceAt = () => 0.3, start = DAY_START, step = 15) {
  return Array.from({ length: count }, (_, i) => ({
    time: new Date(start + i * step * MINUTE).toISOString(),
    price: priceAt(i)
  }));
}

function find(prices, options = {}) {
  return findCheapestWindow(prices, {
    date: '2026-11-02',
    timezone: TIMEZONE,
    hours: 4,
    resolutionMinutes: 15,
    ...options
  });
}

describe('findCheapestWindow', () => {
  test('a window can start on a quarter hour', () => {
    // 12:15-16:15 local is quarters 49 to 64.
    const prices = quarters(96, i => (i >= 49 && i <= 64 ? 0.1 : 0.3));

    expect(find(prices)).toEqual({
      date: '2026-11-02',
      start: '2026-11-02T11:15:00.000Z',
      end: '2026-11-02T15:15:00.000Z',
      averagePrice: expect.closeTo(0.1, 10)
    });
  });

  test('picks the lowest average, not the single lowest price', () => {
    // One very cheap quarter in an expensive stretch loses to a steady cheap block.
    const prices = quarters(96, i => {
      if (i === 8) return -1;
      if (i >= 60 && i <= 75) return 0.1;
      return 0.5;
    });

    expect(find(prices).start).toBe('2026-11-02T14:00:00.000Z');
  });

  test('equal averages go to the earliest start', () => {
    expect(find(quarters()).start).toBe('2026-11-01T23:00:00.000Z');
  });

  test('uses whole hours where the zone only publishes hourly prices', () => {
    const prices = quarters(24, i => (i >= 10 && i <= 12 ? 0.1 : 0.3), DAY_START, 60);

    const window = find(prices, { hours: 3, resolutionMinutes: 60 });

    expect(window.start).toBe('2026-11-02T09:00:00.000Z');
    expect(window.end).toBe('2026-11-02T12:00:00.000Z');
  });

  describe('from and to', () => {
    // The cheap block is 12:15-16:15 local.
    const prices = quarters(96, i => (i >= 49 && i <= 64 ? 0.1 : 0.3));

    test('the window lies entirely inside them', () => {
      const window = find(prices, { from: 14, to: 22 });

      expect(window.start).toBe('2026-11-02T13:00:00.000Z');
      expect(window.end).toBe('2026-11-02T17:00:00.000Z');
    });

    test('a window may end exactly at to', () => {
      expect(find(prices, { from: 7, to: 11 }).end).toBe('2026-11-02T10:00:00.000Z');
    });

    test('to=24 reaches local midnight', () => {
      const lateCheap = quarters(96, i => (i >= 80 ? 0.1 : 0.3));

      expect(find(lateCheap, { from: 0, to: 24 }).end).toBe('2026-11-02T23:00:00.000Z');
    });

    test('follow local time on a daylight saving change', () => {
      // 25 Oct 2026 has 25 hours in Amsterdam and starts at 22:00Z in CEST. 07:00 local is 06:00Z, in CET.
      const prices = quarters(100, () => 0.3, Date.parse('2026-10-24T22:00:00Z'));

      const window = find(prices, { date: '2026-10-25', from: 7, to: 22 });

      expect(window.start).toBe('2026-10-25T06:00:00.000Z');
    });
  });

  describe('incomplete days', () => {
    test.each([
      ['no prices', []],
      ['the end of the day missing', quarters(95)],
      ['the start of the day missing', quarters(95, () => 0.3, DAY_START + 15 * MINUTE)],
      ['a gap in the day', quarters(96).filter((_, i) => i !== 40)]
    ])('no window with %s', (_name, prices) => {
      expect(find(prices)).toBeNull();
    });

    test('a gap outside from and to still counts', () => {
      expect(
        find(
          quarters(96).filter((_, i) => i !== 2),
          { from: 7, to: 22 }
        )
      ).toBeNull();
    });

    test('prices of other days are ignored', () => {
      const withNeighbours = quarters(96 * 3, () => 0.3, DAY_START - 96 * 15 * MINUTE);

      expect(find(withNeighbours).start).toBe('2026-11-01T23:00:00.000Z');
    });

    test('a complete 25-hour day is accepted', () => {
      const prices = quarters(100, () => 0.3, Date.parse('2026-10-24T22:00:00Z'));

      expect(find(prices, { date: '2026-10-25' })).not.toBeNull();
    });

    test('a 25-hour day with only 24 hours of prices is not', () => {
      const prices = quarters(96, () => 0.3, Date.parse('2026-10-24T22:00:00Z'));

      expect(find(prices, { date: '2026-10-25' })).toBeNull();
    });
  });

  test('no window when it does not fit the day', () => {
    // 29 Mar 2026 has 23 hours in Amsterdam.
    const prices = quarters(92, () => 0.3, Date.parse('2026-03-28T23:00:00Z'));

    expect(find(prices, { date: '2026-03-29', hours: 24 })).toBeNull();
  });
});

describe('findUpcomingWindow', () => {
  const TOMORROW_START = DAY_START + 96 * 15 * MINUTE;
  const twoDays = priceAt => quarters(192, priceAt);
  const upcoming = (prices, options = {}) =>
    findUpcomingWindow(prices, {
      date: '2026-11-02',
      timezone: TIMEZONE,
      hours: 4,
      resolutionMinutes: 15,
      now: new Date('2026-11-02T07:00:00Z'),
      ...options
    });

  test('finds the cheapest block still ahead', () => {
    const prices = quarters(96, i => (i >= 49 && i <= 64 ? 0.1 : 0.3));

    expect(upcoming(prices)).toEqual({
      date: '2026-11-02',
      start: '2026-11-02T11:15:00.000Z',
      end: '2026-11-02T15:15:00.000Z',
      averagePrice: expect.closeTo(0.1, 10)
    });
  });

  test('never suggests a start in the past', () => {
    const prices = quarters(96, i => (i >= 49 && i <= 64 ? 0.1 : 0.3));

    const window = upcoming(prices, { now: new Date('2026-11-02T14:00:00Z') });

    expect(window.start).toBe('2026-11-02T14:00:00.000Z');
  });

  test('starts at the next quarter hour', () => {
    const window = upcoming(quarters(96), { now: new Date('2026-11-02T14:07:00Z') });

    expect(window.start).toBe('2026-11-02T14:15:00.000Z');
  });

  test('can run past midnight once the next day is published', () => {
    // Cheap from 23:00 to 03:00 local. Asked at 20:00.
    const prices = twoDays(i => (i >= 92 && i < 108 ? 0.1 : 0.3));

    const window = upcoming(prices, { now: new Date('2026-11-02T19:00:00Z') });

    expect(window).toMatchObject({
      date: '2026-11-02',
      start: '2026-11-02T22:00:00.000Z',
      end: '2026-11-03T02:00:00.000Z'
    });
  });

  test('has to start on the requested day', () => {
    // The cheapest block overall starts at 01:00 the next day.
    const prices = twoDays(i => (i >= 100 && i < 116 ? 0.1 : 0.3));

    const window = upcoming(prices, { now: new Date('2026-11-02T19:00:00Z') });

    expect(Date.parse(window.start)).toBeLessThan(TOMORROW_START);
  });

  test('no window if it would run past the known prices', () => {
    expect(upcoming(quarters(96), { now: new Date('2026-11-02T20:00:00Z') })).toBeNull();
  });

  test('a gap in the next day stops a window from crossing it', () => {
    const prices = twoDays(() => 0.3).filter((_, i) => i !== 96);

    const window = upcoming(prices, { now: new Date('2026-11-02T20:00:00Z') });

    expect(window).toBeNull();
  });

  test('a later day can start from a local hour', () => {
    // The cheap block is 03:00-07:00 local the next day. Asked for 07:00 onward.
    const prices = twoDays(i => (i >= 108 && i < 124 ? 0.1 : 0.3));

    const window = upcoming(prices, { date: '2026-11-03', from: 7, now: new Date('2026-11-02T19:00:00Z') });

    expect(window.start).toBe('2026-11-03T06:00:00.000Z');
  });

  test('to is the latest finish', () => {
    // Cheapest after 18:00, next cheapest right up to it.
    const prices = quarters(96, i => {
      if (i >= 72) return 0.05;
      return i >= 56 ? 0.1 : 0.3;
    });

    const window = upcoming(prices, { to: 18 });

    expect(window.end).toBe('2026-11-02T17:00:00.000Z');
  });

  test('to=24 keeps the window inside the day', () => {
    const prices = twoDays(i => (i >= 92 && i < 108 ? 0.1 : 0.3));

    const window = upcoming(prices, { to: 24, now: new Date('2026-11-02T19:00:00Z') });

    expect(window.end).toBe('2026-11-02T23:00:00.000Z');
  });

  test('accepts parts of an hour', () => {
    const window = upcoming(quarters(96), { hours: 3.5 });

    expect(window.end).toBe('2026-11-02T10:30:00.000Z');
  });

  test('rounds up to whole hours for hourly prices', () => {
    const prices = quarters(24, () => 0.3, DAY_START, 60);

    const window = upcoming(prices, { hours: 3.5, resolutionMinutes: 60 });

    expect(window.end).toBe('2026-11-02T11:00:00.000Z');
  });

  test('no window for a day with missing prices', () => {
    expect(upcoming(quarters(95))).toBeNull();
  });
});

describe('hasCompleteDay', () => {
  const check = prices => hasCompleteDay(prices, { date: '2026-11-02', timezone: TIMEZONE, resolutionMinutes: 15 });

  test('true when every quarter is there', () => {
    expect(check(quarters())).toBe(true);
  });

  test('false when any is missing', () => {
    expect(check(quarters(95))).toBe(false);
  });
});

describe('localDate', () => {
  test('uses the date in the country, not in UTC', () => {
    expect(localDate(new Date('2026-11-01T23:30:00Z'), TIMEZONE)).toBe('2026-11-02');
  });

  test('adds days across a month end', () => {
    expect(localDate(new Date('2026-10-31T12:00:00Z'), TIMEZONE, 1)).toBe('2026-11-01');
  });
});
