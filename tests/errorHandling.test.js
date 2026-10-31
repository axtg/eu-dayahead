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

// The first 6 hours of 31 October in the Netherlands, which starts at 23:00Z the day before.
const SIX_HOURS_OF_TODAY = `<Publication_MarketDocument><TimeSeries><Period>
  <timeInterval><start>2026-10-30T23:00Z</start><end>2026-10-31T05:00Z</end></timeInterval>
  <resolution>PT60M</resolution>
  <Point><position>1</position><price.amount>50</price.amount></Point>
</Period></TimeSeries></Publication_MarketDocument>`;

const PRICE_ROUTES = [
  '/api/nl/today',
  '/api/nl/next24h',
  '/api/nl/next/6',
  '/api/providers/next-energy',
  '/api/providers/eneco/nl'
];

describe('error responses', () => {
  let originalKey;
  let entsoe;

  function loadApp(mockHelpers) {
    let app;
    jest.isolateModules(() => {
      if (mockHelpers)
        jest.doMock('../utils/helpers', () => ({ ...jest.requireActual('../utils/helpers'), ...mockHelpers }));
      const { EntsoeAPI } = require('../entsoe');
      const { StekkerAPI } = require('../stekker');
      EntsoeAPI.prototype.makeRequest = (...args) => entsoe(...args);
      StekkerAPI.prototype.makeRequest = async () => {
        throw new Error('HTTP 503 from stekker.app');
      };
      app = require('../index');
    });
    jest.dontMock('../utils/helpers');
    return app;
  }

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-31T17:00:00Z'), doNotFake: REAL_TIME_APIS });
    originalKey = process.env.ENTSOE_API_KEY;
    process.env.ENTSOE_API_KEY = 'test-key';
    console.error.mockClear();
    entsoe = jest.fn(async () => {
      throw new Error('ENTSOE 503 internal detail');
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    if (originalKey === undefined) delete process.env.ENTSOE_API_KEY;
    else process.env.ENTSOE_API_KEY = originalKey;
  });

  describe('when every upstream fails', () => {
    test.each(PRICE_ROUTES)('%s returns 503 without upstream details', async route => {
      const response = await request(loadApp()).get(route).expect(503);

      expect(response.body.status).toBe('error');
      expect(response.body.message).toContain('temporarily unavailable');
      expect(JSON.stringify(response.body)).not.toMatch(/stekker|entsoe|HTTP/i);
    });

    test('the repeat answer from the failure cache is the same', async () => {
      const app = loadApp();
      await request(app).get('/api/nl/today').expect(503);

      await request(app).get('/api/nl/today').expect(503);
      expect(entsoe).toHaveBeenCalledTimes(1);
    });
  });

  describe('when the cached prices end before the requested window starts', () => {
    beforeEach(() => entsoe.mockImplementation(async () => SIX_HOURS_OF_TODAY));

    test('/today still returns them with a warning', async () => {
      const response = await request(loadApp()).get('/api/nl/today').expect(200);

      expect(response.body.data).toHaveLength(6);
      expect(response.body.warnings).toEqual(['incomplete_data: prices missing for part of today']);
    });

    test.each(['/api/nl/next24h', '/api/nl/next/6'])('%s returns 503 rather than no prices', async route => {
      const response = await request(loadApp()).get(route).expect(503);

      expect(response.body.message).toContain('temporarily unavailable');
    });
  });

  test('an unexpected error returns 500 without its message, and is logged', async () => {
    const app = loadApp({
      fetchCountryPrices: async () => {
        throw new Error('secret internal detail');
      }
    });

    const response = await request(app).get('/api/nl/today').expect(500);

    expect(response.body).toEqual({ status: 'error', message: 'Internal server error' });
    expect(console.error.mock.calls.flat().some(arg => arg?.message === 'secret internal detail')).toBe(true);
  });

  test.each(['/api/%E0%A4%A/today', '/%E0%A4%A'])('a malformed URL (%s) gets a JSON 400', async url => {
    const response = await request(loadApp()).get(url).expect(400).expect('Content-Type', /json/);

    expect(response.body.status).toBe('error');
  });

  test.each(['/api/nl/today?interval=bad', '/api/nl/today?vat=21', '/api/providers/next-energy?interval=bad'])(
    'an invalid parameter (%s) still explains itself',
    async url => {
      const response = await request(loadApp()).get(url).expect(400);

      expect(response.body.message).toMatch(/^Invalid /);
    }
  );
});
