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

describe('GET /api/:country/tomorrow', () => {
  let originalKey;

  function loadApp(xml) {
    let app;
    jest.isolateModules(() => {
      const { EntsoeAPI } = require('../entsoe');
      const { StekkerAPI } = require('../stekker');
      EntsoeAPI.prototype.makeRequest = async () => xml;
      StekkerAPI.prototype.makeRequest = async () => {
        throw new Error('HTTP 503 from stekker.app');
      };
      app = require('../index');
    });
    return app;
  }

  function setNow(iso) {
    jest.useFakeTimers({ now: new Date(iso), doNotFake: REAL_TIME_APIS });
  }

  beforeEach(() => {
    originalKey = process.env.ENTSOE_API_KEY;
    process.env.ENTSOE_API_KEY = 'test-key';
  });

  afterEach(() => {
    jest.useRealTimers();
    if (originalKey === undefined) delete process.env.ENTSOE_API_KEY;
    else process.env.ENTSOE_API_KEY = originalKey;
  });

  test('returns the next local day once it is published', async () => {
    setNow('2026-10-31T17:00:00Z');
    const app = loadApp(hourlyXml('2026-10-30T23:00Z', '2026-11-01T23:00Z', 48));

    const { body } = await request(app).get('/api/nl/tomorrow').expect(200);

    expect(body.info.type).toBe('tomorrow');
    expect(body.info.date).toBe('1-11-2026');
    expect(body.data).toHaveLength(24);
    expect(body.data[0].time).toBe('2026-10-31T23:00:00.000Z');
    expect(body.data[23].time).toBe('2026-11-01T22:00:00.000Z');
  });

  test('returns no prices, rather than an error, before they are published', async () => {
    setNow('2026-10-31T09:00:00Z');
    const app = loadApp(hourlyXml('2026-10-30T23:00Z', '2026-10-31T23:00Z', 24));

    const { body } = await request(app).get('/api/nl/tomorrow').expect(200);

    expect(body.data).toEqual([]);
  });

  test('covers all 25 hours when tomorrow is the day the clocks go back', async () => {
    setNow('2026-10-24T17:00:00Z');
    const app = loadApp(hourlyXml('2026-10-23T22:00Z', '2026-10-25T23:00Z', 49));

    const { body } = await request(app).get('/api/nl/tomorrow').expect(200);

    expect(body.data).toHaveLength(25);
    expect(body.data[0].time).toBe('2026-10-24T22:00:00.000Z');
    expect(body.data[24].time).toBe('2026-10-25T22:00:00.000Z');
  });
});
