const { findCheapestStart, startLabel, formatLength } = require('../public/cheapestStart');

const HOUR_MS = 3_600_000;
const FIRST_PRICE = Date.parse('2026-11-02T18:00:00Z');

function prices(values, stepMinutes = 60) {
  return values.map((price, i) => ({
    time: new Date(FIRST_PRICE + i * stepMinutes * 60_000).toISOString(),
    price
  }));
}

function find(priceList, lengthMinutes, nowMs = FIRST_PRICE, resolutionMinutes = 60) {
  return findCheapestStart(priceList, { lengthMinutes, resolutionMinutes, nowMs });
}

const at1823 = FIRST_PRICE + 23 * 60_000;

describe('findCheapestStart', () => {
  test('only starts a whole number of hours from now, weighing the parts of each price it covers', () => {
    // Prices of 0.1 at exactly 21:00-23:00, which a start at xx:23 can't line up with.
    // 20:23-22:23 averages (37*0.3 + 83*0.1)/120 = 0.16167; 21:23-23:23 averages (97*0.1 + 23*0.3)/120 = 0.13833.
    const window = find(prices([0.3, 0.3, 0.3, 0.1, 0.1, 0.3, 0.3, 0.3]), 120, at1823);

    expect(window.delayHours).toBe(3);
    expect(window.start).toBe('2026-11-02T21:23:00.000Z');
    expect(window.end).toBe('2026-11-02T23:23:00.000Z');
    expect(window.averagePrice).toBeCloseTo(0.13833, 5);
  });

  test('can start right now when that is cheapest', () => {
    expect(find(prices([0.1, 0.1, 0.3, 0.3, 0.3]), 120).delayHours).toBe(0);
  });

  test('weighs quarter-hour prices for a window that starts inside a quarter', () => {
    // 18:10-18:40 covers 5 min at 0.2, 15 min at 0.4 and 10 min at 0.4: 11/30.
    const quarters = prices([0.2, 0.4, 0.4, 0.4], 15);
    const window = find(quarters, 30, FIRST_PRICE + 10 * 60_000, 15);

    expect(window.delayHours).toBe(0);
    expect(window.averagePrice).toBeCloseTo(0.36667, 5);
  });

  test("ignores a cheaper window more than 20 hours away, which a delay timer can't reach", () => {
    const values = Array(26).fill(0.3);
    values[20] = 0.2;
    values[22] = 0.05;

    expect(find(prices(values), 60).delayHours).toBe(20);
  });

  test('needs prices for the whole window', () => {
    // Starting in 2 hours would be cheapest, but its second hour has no price yet.
    const window = find(prices([0.3, 0.3, 0.1]), 120);

    expect(window.delayHours).toBe(1);
    expect(window.averagePrice).toBeCloseTo(0.2, 5);
  });

  test("doesn't run a window across a gap in the prices", () => {
    const list = prices([0.3, 0.3, 0.05, 0, 0.05, 0.3]);
    list.splice(3, 1);

    // Starting in 2 hours would average 0.05 if the gap were ignored. In 1 and 4 hours both average 0.175.
    const window = find(list, 120);

    expect(window.delayHours).toBe(1);
    expect(window.averagePrice).toBeCloseTo(0.175, 5);
  });

  test('takes the earliest of equally cheap windows, despite rounding in the averages', () => {
    expect(find(prices(Array(8).fill(0.07)), 60, at1823).delayHours).toBe(0);
  });

  test("doesn't start before the first known price", () => {
    const window = find(prices([0.3, 0.3]), 60, FIRST_PRICE - HOUR_MS);

    expect(window.delayHours).toBe(1);
  });

  test('returns null when no window fits', () => {
    expect(find(prices([0.1, 0.2]), 180)).toBeNull();
    expect(find([], 60)).toBeNull();
  });
});

describe('startLabel', () => {
  test.each([
    [0, 'Start now'],
    [1, 'Start in 1 hour'],
    [5, 'Start in 5 hours']
  ])('a delay of %i hours reads "%s"', (delayHours, label) => {
    expect(startLabel(delayHours)).toBe(label);
  });
});

describe('formatLength', () => {
  test.each([
    [15, '0:15'],
    [60, '1:00'],
    [270, '4:30']
  ])('%i minutes reads %s', (minutes, label) => {
    expect(formatLength(minutes)).toBe(label);
  });
});
