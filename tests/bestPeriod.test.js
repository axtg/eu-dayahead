const request = require('supertest');

const REAL_TIME_APIS = [
  'hrtime',
  'nextTick',
  'performance',
  'queueMicrotask',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'requestIdleCallback',
  'cancelIdleCallback',
  'setImmediate',
  'clearImmediate',
  'setInterval',
  'clearInterval',
  'setTimeout',
  'clearTimeout'
];

// Hourly prices from 00:00 on 31 October in the Netherlands (23:00Z the day before) for 48 hours.
// The price of position n is n, so the cheapest window is always the first one.
function hourlyXml(start, end, hours) {
  const points = Array.from(
    { length: hours },
    (_, i) => `<Point><position>${i + 1}</position><price.amount>${i + 1}</price.amount></Point>`
  ).join('');
  return `<Publication_MarketDocument><TimeSeries><Period>
  <timeInterval><start>${start}</start><end>${end}</end></timeInterval>
  <resolution>PT60M</resolution>${points}
</Period></TimeSeries></Publication_MarketDocument>`;
}

const TWO_DAYS = hourlyXml('2026-10-30T23:00Z', '2026-11-01T23:00Z', 48);
const SIX_HOURS = hourlyXml('2026-10-30T23:00Z', '2026-10-31T05:00Z', 6);

describe('bestPeriodHours', () => {
  let originalKey;
  let entsoe;

  function loadApp() {
    let app;
    jest.isolateModules(() => {
      const { EntsoeAPI } = require('../entsoe');
      const { StekkerAPI } = require('../stekker');
      EntsoeAPI.prototype.makeRequest = (...args) => entsoe(...args);
      StekkerAPI.prototype.makeRequest = async () => {
        throw new Error('HTTP 503 from stekker.app');
      };
      app = require('../index');
    });
    return app;
  }

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-31T17:00:00Z'), doNotFake: REAL_TIME_APIS });
    originalKey = process.env.ENTSOE_API_KEY;
    process.env.ENTSOE_API_KEY = 'test-key';
    entsoe = jest.fn(async () => TWO_DAYS);
  });

  afterEach(() => {
    jest.useRealTimers();
    if (originalKey === undefined) delete process.env.ENTSOE_API_KEY;
    else process.env.ENTSOE_API_KEY = originalKey;
  });

  describe.each(['/api/nl/today', '/api/nl/next24h', '/api/nl/next/6'])('%s', route => {
    test('returns the cheapest period inside data', async () => {
      const { body } = await request(loadApp()).get(`${route}?bestPeriodHours=2`).expect(200);
      const times = body.data.map(p => new Date(p.time).getTime());

      expect(body.bestPeriod.hours).toBe(2);
      expect(body.bestPeriod.intervals).toBe((2 * 60) / body.info.resolutionMinutes);
      expect(times).toContain(new Date(body.bestPeriod.startTime).getTime());
      expect(new Date(body.bestPeriod.endTime).getTime()).toBeLessThanOrEqual(
        Math.max(...times) + body.info.resolutionMinutes * 60000
      );
      expect(body.info).not.toHaveProperty('bestPeriod');
    });

    test('is absent without the parameter', async () => {
      const { body } = await request(loadApp()).get(route).expect(200);

      expect(body).not.toHaveProperty('bestPeriod');
    });

    test('an empty value behaves as absent', async () => {
      const { body } = await request(loadApp()).get(`${route}?bestPeriodHours=`).expect(200);

      expect(body).not.toHaveProperty('bestPeriod');
    });
  });

  test('is null when data covers fewer hours than asked', async () => {
    entsoe.mockImplementation(async () => SIX_HOURS);
    const { body } = await request(loadApp()).get('/api/nl/today?bestPeriodHours=8').expect(200);

    expect(body.bestPeriod).toBeNull();
    expect(body.info).not.toHaveProperty('bestPeriod');
  });

  test('hourly-only data requested at 15M still counts hours correctly', async () => {
    const { body } = await request(loadApp()).get('/api/ch/next/6?interval=15M&bestPeriodHours=2').expect(200);

    expect(body.info.resolutionMinutes).toBe(60);
    expect(body.bestPeriod.intervals).toBe(2);
  });
});
