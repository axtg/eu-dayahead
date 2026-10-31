// Upstream HTTP is stubbed at makeRequest; only Date is faked so promises and real timers keep working.
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

const MINUTE = 60_000;

// All dates are in CET (UTC+1). A local NL day starts at 23:00Z the day before.
function dayStartUtc(day) {
  return new Date(new Date(`${day}T00:00:00Z`).getTime() - 60 * MINUTE);
}

function entsoeXml(days, amount = 50) {
  const series = days.map(day => {
    const start = dayStartUtc(day);
    const end = new Date(start.getTime() + 1440 * MINUTE);
    const format = date => `${date.toISOString().slice(0, 16)}Z`;
    return `<TimeSeries><Period>
      <timeInterval><start>${format(start)}</start><end>${format(end)}</end></timeInterval>
      <resolution>PT60M</resolution>
      <Point><position>1</position><price.amount>${amount}</price.amount></Point>
    </Period></TimeSeries>`;
  });
  return `<Publication_MarketDocument>${series.join('')}</Publication_MarketDocument>`;
}

function stekkerHtml(day, amount = 70) {
  const start = dayStartUtc(day).getTime();
  const x = Array.from({ length: 24 }, (_, i) => new Date(start + i * 60 * MINUTE).toISOString());
  const y = x.map(() => amount);
  const json = JSON.stringify([{ name: 'Market price', x, y }]).replace(/"/g, '&quot;');
  return `<div data-epex-forecast-graph-data-value="${json}">price</div>`;
}

describe('price cache', () => {
  let helpers;
  let entsoe;
  let stekker;
  let originalKey;

  function setClock(iso) {
    jest.setSystemTime(new Date(iso));
  }

  function advance(minutes) {
    jest.setSystemTime(Date.now() + minutes * MINUTE);
  }

  const lastTime = result => result.prices[result.prices.length - 1].time;
  const fetchNl = () => helpers.fetchCountryPrices('nl', {}, { interval: '60M' });

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-31T07:00:00Z'), doNotFake: REAL_TIME_APIS });
    originalKey = process.env.ENTSOE_API_KEY;
    process.env.ENTSOE_API_KEY = 'test-key';
    console.error.mockClear();

    entsoe = jest.fn(async () => entsoeXml(['2026-10-31']));
    stekker = jest.fn(async () => {
      throw new Error('HTTP 503');
    });
    jest.isolateModules(() => {
      const { EntsoeAPI } = require('../entsoe');
      const { StekkerAPI } = require('../stekker');
      EntsoeAPI.prototype.makeRequest = (...args) => entsoe(...args);
      StekkerAPI.prototype.makeRequest = (...args) => stekker(...args);
      helpers = require('../utils/helpers');
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    if (originalKey === undefined) delete process.env.ENTSOE_API_KEY;
    else process.env.ENTSOE_API_KEY = originalKey;
  });

  describe('avoiding upstream calls', () => {
    test('repeat requests are served from the cache', async () => {
      await fetchNl();
      advance(60);
      await fetchNl();

      expect(entsoe).toHaveBeenCalledTimes(1);
    });

    test('concurrent requests on an empty cache share one upstream call', async () => {
      entsoe.mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
        return entsoeXml(['2026-10-31']);
      });

      const results = await Promise.all(Array.from({ length: 25 }, fetchNl));

      expect(entsoe).toHaveBeenCalledTimes(1);
      results.forEach(result => expect(result.prices).toHaveLength(24));
    });

    test('different countries do not share an upstream call', async () => {
      await Promise.all([fetchNl(), helpers.fetchCountryPrices('be', {}, {})]);

      expect(entsoe).toHaveBeenCalledTimes(2);
    });
  });

  test('without an ENTSOE key, Stekker data is not refetched every few minutes', async () => {
    delete process.env.ENTSOE_API_KEY;
    stekker.mockImplementation(async () => stekkerHtml('2026-10-31'));
    jest.isolateModules(() => {
      const { StekkerAPI } = require('../stekker');
      StekkerAPI.prototype.makeRequest = (...args) => stekker(...args);
      helpers = require('../utils/helpers');
    });

    await fetchNl();
    advance(60);
    await fetchNl();

    expect(stekker).toHaveBeenCalledTimes(1);
  });

  describe('refreshing without making visitors wait', () => {
    test('serves current data immediately while the refresh runs, then the new data', async () => {
      await fetchNl();
      setClock('2026-10-31T13:31:00Z');

      let finishRefresh;
      entsoe.mockImplementation(async () => {
        await new Promise(resolve => (finishRefresh = resolve));
        return entsoeXml(['2026-10-31', '2026-11-01']);
      });

      const during = await fetchNl();
      expect(lastTime(during)).toBe('2026-10-31T22:00:00.000Z');
      expect(entsoe).toHaveBeenCalledTimes(2);

      finishRefresh();
      await new Promise(resolve => setImmediate(resolve));

      expect(lastTime(await fetchNl())).toBe('2026-11-01T22:00:00.000Z');
    });

    test('waits for fresh data when the cached data no longer covers today', async () => {
      await fetchNl();
      setClock('2026-11-01T00:10:00Z');
      entsoe.mockImplementation(async () => entsoeXml(['2026-11-01']));

      expect(lastTime(await fetchNl())).toBe('2026-11-01T22:00:00.000Z');
    });

    test('serves data fetched yesterday afternoon straight after midnight', async () => {
      setClock('2026-10-31T14:00:00Z');
      entsoe.mockImplementation(async () => entsoeXml(['2026-10-31', '2026-11-01']));
      await fetchNl();

      setClock('2026-10-31T23:00:01Z');
      entsoe.mockImplementation(() => new Promise(() => {}));

      expect(lastTime(await fetchNl())).toBe('2026-11-01T22:00:00.000Z');
      expect(entsoe).toHaveBeenCalledTimes(2);
    });
  });

  describe('when the next day is published late', () => {
    beforeEach(() => setClock('2026-10-31T13:40:00Z'));

    test('retries after 15 minutes if the data has no next day yet', async () => {
      await fetchNl();
      advance(14);
      await fetchNl();
      expect(entsoe).toHaveBeenCalledTimes(1);

      advance(1);
      entsoe.mockImplementation(async () => entsoeXml(['2026-10-31', '2026-11-01']));
      await fetchNl();
      expect(entsoe).toHaveBeenCalledTimes(2);
    });

    test('stops retrying once the next day has arrived', async () => {
      entsoe.mockImplementation(async () => entsoeXml(['2026-10-31', '2026-11-01']));
      await fetchNl();
      advance(120);
      await fetchNl();

      expect(entsoe).toHaveBeenCalledTimes(1);
    });
  });

  describe('when ENTSOE fails', () => {
    beforeEach(() => {
      entsoe.mockImplementation(async () => {
        throw new Error('ENTSOE request timed out');
      });
      stekker.mockImplementation(async () => stekkerHtml('2026-10-31'));
    });

    test('falls back to Stekker with a warning', async () => {
      const result = await fetchNl();

      expect(result.source).toBe('stekker');
      expect(result.warnings).toEqual(['fallback_source: stekker']);
    });

    test('returns to ENTSOE after 5 minutes rather than keeping fallback data', async () => {
      await fetchNl();
      advance(4);
      await fetchNl();
      expect(entsoe).toHaveBeenCalledTimes(1);

      advance(1);
      entsoe.mockImplementation(async () => entsoeXml(['2026-10-31']));
      await fetchNl();
      await new Promise(resolve => setImmediate(resolve));

      expect((await fetchNl()).source).toBe('entsoe');
    });

    test('logs why ENTSOE failed', async () => {
      await fetchNl();

      expect(JSON.stringify(console.error.mock.calls)).toContain('ENTSOE request timed out');
    });
  });

  describe('when all upstreams fail', () => {
    const failEverything = () => {
      entsoe.mockImplementation(async () => {
        throw new Error('ENTSOE 503');
      });
      stekker.mockImplementation(async () => {
        throw new Error('HTTP 503');
      });
    };

    test('keeps serving the previous prices with a warning', async () => {
      await fetchNl();
      setClock('2026-10-31T13:31:00Z');
      failEverything();

      await fetchNl();
      await new Promise(resolve => setImmediate(resolve));
      const result = await fetchNl();

      expect(result.prices).toHaveLength(24);
      expect(result.warnings).toEqual(['stale_data: upstream refresh failed']);
    });

    test('waits a minute before trying again', async () => {
      await fetchNl();
      setClock('2026-10-31T13:31:00Z');
      failEverything();

      await fetchNl();
      await new Promise(resolve => setImmediate(resolve));
      await fetchNl();
      expect(entsoe).toHaveBeenCalledTimes(2);

      advance(1);
      await fetchNl();
      expect(entsoe).toHaveBeenCalledTimes(3);
    });

    test('clears the warning once a refresh succeeds', async () => {
      await fetchNl();
      setClock('2026-10-31T13:31:00Z');
      failEverything();
      await fetchNl();
      await new Promise(resolve => setImmediate(resolve));

      advance(1);
      entsoe.mockImplementation(async () => entsoeXml(['2026-10-31', '2026-11-01']));
      await fetchNl();
      await new Promise(resolve => setImmediate(resolve));

      expect((await fetchNl()).warnings).toBeUndefined();
    });

    test('with nothing cached, fails without calling upstream again for a minute', async () => {
      failEverything();

      await expect(fetchNl()).rejects.toThrow();
      await expect(fetchNl()).rejects.toThrow();
      expect(entsoe).toHaveBeenCalledTimes(1);

      advance(1);
      await expect(fetchNl()).rejects.toThrow();
      expect(entsoe).toHaveBeenCalledTimes(2);
    });

    test('a failed background refresh does not cause an unhandled rejection', async () => {
      const unhandled = jest.fn();
      process.on('unhandledRejection', unhandled);

      await fetchNl();
      setClock('2026-10-31T13:31:00Z');
      failEverything();
      await fetchNl();
      await new Promise(resolve => setTimeout(resolve, 10));

      process.off('unhandledRejection', unhandled);
      expect(unhandled).not.toHaveBeenCalled();
    });

    test('an empty result does not replace good data', async () => {
      await fetchNl();
      setClock('2026-10-31T13:31:00Z');
      entsoe.mockImplementation(async () => '<Publication_MarketDocument></Publication_MarketDocument>');
      stekker.mockImplementation(async () => stekkerHtml('2026-10-01'));

      await fetchNl();
      await new Promise(resolve => setImmediate(resolve));

      expect((await fetchNl()).prices).toHaveLength(24);
    });
  });

  describe('upstream call logging', () => {
    test('sends the source, country, duration and errors to the log, without the API key', async () => {
      const originalFetch = global.fetch;
      const originalToken = process.env.LOGTAIL_TOKEN;
      global.fetch = jest.fn().mockResolvedValue({ ok: true });
      process.env.LOGTAIL_TOKEN = 'test-token';

      try {
        entsoe.mockImplementation(async () => {
          throw new Error('ENTSOE 503');
        });
        stekker.mockImplementation(async () => stekkerHtml('2026-10-31'));
        jest.isolateModules(() => {
          const { EntsoeAPI } = require('../entsoe');
          const { StekkerAPI } = require('../stekker');
          EntsoeAPI.prototype.makeRequest = (...args) => entsoe(...args);
          StekkerAPI.prototype.makeRequest = (...args) => stekker(...args);
          helpers = require('../utils/helpers');
        });

        await fetchNl();

        const body = global.fetch.mock.calls[0][1].body;
        expect(JSON.parse(body)).toMatchObject({
          message: 'Upstream fetch: nl from stekker',
          country: 'nl',
          source: 'stekker',
          upstreamErrors: ['entsoe: ENTSOE 503']
        });
        expect(JSON.parse(body).durationMs).toEqual(expect.any(Number));
        expect(body).not.toContain('test-key');
      } finally {
        global.fetch = originalFetch;
        process.env.LOGTAIL_TOKEN = originalToken;
      }
    });
  });
});
