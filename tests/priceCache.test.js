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

// partialDays maps a day to how many of its hours to include: { '2026-11-01': 6 }
function entsoeXml(days, amount = 50, partialDays = {}) {
  const hoursByDay = [...days.map(day => [day, 24]), ...Object.entries(partialDays)];
  const series = hoursByDay.map(([day, hours]) => {
    const start = dayStartUtc(day);
    const end = new Date(start.getTime() + hours * 60 * MINUTE);
    const format = date => `${date.toISOString().slice(0, 16)}Z`;
    return `<TimeSeries><Period>
      <timeInterval><start>${format(start)}</start><end>${format(end)}</end></timeInterval>
      <resolution>PT60M</resolution>
      <Point><position>1</position><price.amount>${amount}</price.amount></Point>
    </Period></TimeSeries>`;
  });
  return `<Publication_MarketDocument>${series.join('')}</Publication_MarketDocument>`;
}

function stekkerHtml(day, amount = 70, hours = 24) {
  const start = dayStartUtc(day).getTime();
  const x = Array.from({ length: hours }, (_, i) => new Date(start + i * 60 * MINUTE).toISOString());
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

  describe('after new prices are published', () => {
    test('the first request gets them, even if its cached data still covers today', async () => {
      await fetchNl();
      setClock('2026-10-31T13:31:00Z');
      entsoe.mockImplementation(async () => entsoeXml(['2026-10-31', '2026-11-01']));

      expect(lastTime(await fetchNl())).toBe('2026-11-01T22:00:00.000Z');
    });

    test('a client polling once a day gets the next day every time', async () => {
      setClock('2026-10-31T14:00:00Z');
      entsoe.mockImplementation(async () => entsoeXml(['2026-10-31', '2026-11-01']));
      await fetchNl();

      setClock('2026-11-01T14:00:00Z');
      entsoe.mockImplementation(async () => entsoeXml(['2026-11-01', '2026-11-02']));

      expect(lastTime(await fetchNl())).toBe('2026-11-02T22:00:00.000Z');
    });

    test('concurrent requests share the call while waiting', async () => {
      await fetchNl();
      setClock('2026-10-31T13:31:00Z');
      entsoe.mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
        return entsoeXml(['2026-10-31', '2026-11-01']);
      });

      await Promise.all(Array.from({ length: 10 }, fetchNl));

      expect(entsoe).toHaveBeenCalledTimes(2);
    });
  });

  describe('refreshing without making visitors wait', () => {
    test('a late-publish retry serves current data while it runs, then the new data', async () => {
      setClock('2026-10-31T13:40:00Z');
      await fetchNl();
      advance(15);

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

  describe('when ENTSOE returns less than a full today', () => {
    const NEW_DAY = '2026-10-31T23:30:00Z';
    const pointsFor = (result, day) => {
      const start = dayStartUtc(day).getTime();
      return result.prices.filter(p => {
        const time = new Date(p.time).getTime();
        return time >= start && time < start + 1440 * MINUTE;
      }).length;
    };
    const entsoeReturnsFullDays = () => entsoe.mockImplementation(async () => entsoeXml(['2026-10-31', '2026-11-01']));

    describe('with good prices cached', () => {
      beforeEach(async () => {
        setClock('2026-10-31T14:00:00Z');
        entsoeReturnsFullDays();
        await fetchNl();
        setClock(NEW_DAY);
      });

      test('a response without today does not replace them', async () => {
        entsoe.mockImplementation(async () => entsoeXml(['2026-10-31']));

        await fetchNl();
        await new Promise(resolve => setImmediate(resolve));
        const result = await fetchNl();

        expect(pointsFor(result, '2026-11-01')).toBe(24);
        expect(result.warnings).toEqual(['stale_data: upstream refresh failed']);
      });

      test('a response with part of today does not replace them', async () => {
        entsoe.mockImplementation(async () => entsoeXml(['2026-10-31'], 50, { '2026-11-01': 6 }));

        await fetchNl();
        await new Promise(resolve => setImmediate(resolve));
        const result = await fetchNl();

        expect(pointsFor(result, '2026-11-01')).toBe(24);
        expect(result.warnings).toEqual(['stale_data: upstream refresh failed']);
      });

      test('ENTSOE is retried after 15 minutes when part of today came back', async () => {
        entsoe.mockImplementation(async () => entsoeXml(['2026-10-31'], 50, { '2026-11-01': 6 }));
        await fetchNl();
        await new Promise(resolve => setImmediate(resolve));
        expect(entsoe).toHaveBeenCalledTimes(2);

        advance(14);
        await fetchNl();
        expect(entsoe).toHaveBeenCalledTimes(2);

        advance(1);
        await fetchNl();
        await new Promise(resolve => setImmediate(resolve));
        expect(entsoe).toHaveBeenCalledTimes(3);
      });
    });

    describe('with nothing cached', () => {
      beforeEach(() => setClock(NEW_DAY));

      test('tries Stekker when ENTSOE has no prices for today', async () => {
        entsoe.mockImplementation(async () => entsoeXml(['2026-10-31']));
        stekker.mockImplementation(async () => stekkerHtml('2026-11-01'));

        const result = await fetchNl();

        expect(stekker).toHaveBeenCalledTimes(1);
        expect(result.source).toBe('stekker');
        expect(pointsFor(result, '2026-11-01')).toBe(24);
      });

      test('fails when no upstream has prices for today, rather than returning none', async () => {
        entsoe.mockImplementation(async () => entsoeXml(['2026-10-31']));

        await expect(fetchNl()).rejects.toThrow();
      });

      test('serves part of today with a warning if that is all there is', async () => {
        entsoe.mockImplementation(async () => entsoeXml(['2026-10-31'], 50, { '2026-11-01': 6 }));

        const result = await fetchNl();

        expect(pointsFor(result, '2026-11-01')).toBe(6);
        expect(result.warnings).toEqual(['incomplete_data: prices missing for part of today']);
      });

      test('retries part of today after 15 minutes instead of waiting for 14:30 CET', async () => {
        entsoe.mockImplementation(async () => entsoeXml(['2026-10-31'], 50, { '2026-11-01': 6 }));
        await fetchNl();
        advance(14);
        await fetchNl();
        expect(entsoe).toHaveBeenCalledTimes(1);

        advance(1);
        entsoeReturnsFullDays();

        expect(pointsFor(await fetchNl(), '2026-11-01')).toBe(24);
        expect(entsoe).toHaveBeenCalledTimes(2);
      });

      test('prefers Stekker when it reaches further than part of today from ENTSOE', async () => {
        entsoe.mockImplementation(async () => entsoeXml(['2026-10-31'], 50, { '2026-11-01': 6 }));
        stekker.mockImplementation(async () => stekkerHtml('2026-11-01'));

        const result = await fetchNl();

        expect(result.source).toBe('stekker');
        expect(result.warnings).toEqual(['fallback_source: stekker']);
      });
    });
  });

  describe('retries across local midnight', () => {
    const fullNextDay = async () => entsoeXml(['2026-11-01']);

    test('fallback data is not kept past midnight when it lacks the new day', async () => {
      setClock('2026-10-31T22:58:00Z');
      entsoe.mockImplementation(async () => {
        throw new Error('ENTSOE 503');
      });
      stekker.mockImplementation(async () => stekkerHtml('2026-10-31'));
      await fetchNl();

      setClock('2026-10-31T23:01:00Z');
      entsoe.mockImplementation(fullNextDay);

      expect(lastTime(await fetchNl())).toBe('2026-11-01T22:00:00.000Z');
      expect(entsoe).toHaveBeenCalledTimes(2);
    });

    test('a failed refresh does not hold old prices past midnight when they lack the new day', async () => {
      setClock('2026-10-31T14:30:00Z');
      await fetchNl();
      setClock('2026-10-31T22:59:30Z');
      entsoe.mockImplementation(async () => {
        throw new Error('ENTSOE 503');
      });
      await fetchNl();
      await new Promise(resolve => setImmediate(resolve));
      expect(entsoe).toHaveBeenCalledTimes(2);

      setClock('2026-10-31T23:00:10Z');
      entsoe.mockImplementation(fullNextDay);

      expect(lastTime(await fetchNl())).toBe('2026-11-01T22:00:00.000Z');
      expect(entsoe).toHaveBeenCalledTimes(3);
    });

    test('kept ENTSOE prices are not held past midnight when they lack the new day', async () => {
      setClock('2026-10-31T14:30:00Z');
      await fetchNl();
      setClock('2026-10-31T22:58:00Z');
      entsoe.mockImplementation(async () => {
        throw new Error('ENTSOE 503');
      });
      stekker.mockImplementation(async () => stekkerHtml('2026-10-31', 70, 3));
      await fetchNl();
      await new Promise(resolve => setImmediate(resolve));
      expect(entsoe).toHaveBeenCalledTimes(2);

      setClock('2026-10-31T23:01:00Z');
      entsoe.mockImplementation(fullNextDay);

      expect(lastTime(await fetchNl())).toBe('2026-11-01T22:00:00.000Z');
      expect(entsoe).toHaveBeenCalledTimes(3);
    });
  });

  describe('when ENTSOE fails and Stekker has partial data', () => {
    beforeEach(() => {
      setClock('2026-10-31T14:00:00Z');
      entsoe.mockImplementation(async () => entsoeXml(['2026-10-31', '2026-11-01']));
    });

    const entsoeFails = () =>
      entsoe.mockImplementation(async () => {
        throw new Error('ENTSOE 503');
      });

    test('keeps ENTSOE prices that reach as far, with a warning', async () => {
      await fetchNl();
      setClock('2026-10-31T23:30:00Z');
      entsoeFails();
      stekker.mockImplementation(async () => stekkerHtml('2026-11-01', 70, 3));

      await fetchNl();
      await new Promise(resolve => setImmediate(resolve));
      const result = await fetchNl();

      expect(result.source).toBe('entsoe');
      expect(result.prices).toHaveLength(48);
      expect(result.warnings).toEqual(['stale_data: upstream refresh failed']);
    });

    test('retries ENTSOE after 5 minutes when it kept the old prices', async () => {
      await fetchNl();
      setClock('2026-10-31T23:30:00Z');
      entsoeFails();
      stekker.mockImplementation(async () => stekkerHtml('2026-11-01', 70, 3));
      await fetchNl();
      await new Promise(resolve => setImmediate(resolve));
      expect(entsoe).toHaveBeenCalledTimes(2);

      advance(4);
      await fetchNl();
      expect(entsoe).toHaveBeenCalledTimes(2);

      advance(1);
      await fetchNl();
      await new Promise(resolve => setImmediate(resolve));
      expect(entsoe).toHaveBeenCalledTimes(3);
    });

    test('uses Stekker when it reaches further than the cached ENTSOE prices', async () => {
      setClock('2026-10-31T07:00:00Z');
      entsoe.mockImplementation(async () => entsoeXml(['2026-10-31']));
      await fetchNl();

      setClock('2026-10-31T13:31:00Z');
      entsoeFails();
      stekker.mockImplementation(async () => stekkerHtml('2026-10-31', 70, 48));
      const result = await fetchNl();

      expect(result.source).toBe('stekker');
      expect(lastTime(result)).toBe('2026-11-01T22:00:00.000Z');
    });

    test('uses Stekker when the cached prices no longer cover today', async () => {
      await fetchNl();
      setClock('2026-11-01T23:30:00Z');
      entsoeFails();
      stekker.mockImplementation(async () => stekkerHtml('2026-11-02'));

      expect((await fetchNl()).source).toBe('stekker');
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

    describe('and Stekker reaches further than ENTSOE once it recovers', () => {
      beforeEach(async () => {
        setClock('2026-10-31T12:30:00Z');
        stekker.mockImplementation(async () => stekkerHtml('2026-10-31', 70, 48));
        await fetchNl();

        advance(6);
        entsoe.mockImplementation(async () => entsoeXml(['2026-10-31']));
        await fetchNl();
        await new Promise(resolve => setImmediate(resolve));
      });

      test('keeps the further prices, without claiming the refresh failed', async () => {
        const result = await fetchNl();

        expect(result.source).toBe('stekker');
        expect(lastTime(result)).toBe('2026-11-01T22:00:00.000Z');
        expect(result.warnings).toEqual(['fallback_source: stekker']);
        expect(helpers.getCacheStats().staleCountries).toEqual([]);
      });

      test('checks ENTSOE again after 5 minutes and switches once it reaches as far', async () => {
        advance(4);
        await fetchNl();
        expect(entsoe).toHaveBeenCalledTimes(2);

        advance(1);
        entsoe.mockImplementation(async () => entsoeXml(['2026-10-31', '2026-11-01']));
        await fetchNl();
        await new Promise(resolve => setImmediate(resolve));
        expect(entsoe).toHaveBeenCalledTimes(3);

        const result = await fetchNl();
        expect(result.source).toBe('entsoe');
        expect(result.warnings).toBeUndefined();
      });
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

    test('with cached prices that no longer cover today, fails rather than returning no prices', async () => {
      await fetchNl();
      setClock('2026-11-01T07:00:00Z');
      failEverything();

      await expect(fetchNl()).rejects.toThrow();
      expect(entsoe).toHaveBeenCalledTimes(2);

      await expect(fetchNl()).rejects.toThrow();
      expect(entsoe).toHaveBeenCalledTimes(2);

      advance(1);
      await expect(fetchNl()).rejects.toThrow();
      expect(entsoe).toHaveBeenCalledTimes(3);
    });

    test('recovers once upstream returns after cached prices stopped covering today', async () => {
      await fetchNl();
      setClock('2026-11-01T07:00:00Z');
      failEverything();
      await expect(fetchNl()).rejects.toThrow();

      advance(1);
      entsoe.mockImplementation(async () => entsoeXml(['2026-11-01']));

      expect(lastTime(await fetchNl())).toBe('2026-11-01T22:00:00.000Z');
    });

    test('a background refresh that fails after today has passed is not an unhandled rejection', async () => {
      const unhandled = jest.fn();
      process.on('unhandledRejection', unhandled);

      setClock('2026-10-31T14:00:00Z');
      entsoe.mockImplementation(async () => entsoeXml(['2026-10-31', '2026-11-01']));
      await fetchNl();

      setClock('2026-10-31T23:00:01Z');
      let failRefresh;
      entsoe.mockImplementation(() => new Promise((_, reject) => (failRefresh = reject)));
      stekker.mockImplementation(async () => {
        throw new Error('HTTP 503');
      });
      await fetchNl();

      setClock('2026-11-03T07:00:00Z');
      failRefresh(new Error('ENTSOE 503'));
      await new Promise(resolve => setTimeout(resolve, 10));

      process.off('unhandledRejection', unhandled);
      expect(unhandled).not.toHaveBeenCalled();
    });

    describe('with only part of today cached', () => {
      beforeEach(async () => {
        entsoe.mockImplementation(async () => entsoeXml([], 50, { '2026-10-31': 12 }));
        await fetchNl();
        advance(16);
        failEverything();
      });

      test('keeps serving those prices, with both warnings', async () => {
        const result = await fetchNl();

        expect(result.prices).toHaveLength(12);
        expect(result.warnings).toEqual([
          'stale_data: upstream refresh failed',
          'incomplete_data: prices missing for part of today'
        ]);
        expect(helpers.getCacheStats().staleCountries).toEqual(['nl']);
      });

      test('waits a minute before trying again', async () => {
        await fetchNl();
        await fetchNl();
        expect(entsoe).toHaveBeenCalledTimes(2);

        advance(1);
        await fetchNl();
        expect(entsoe).toHaveBeenCalledTimes(3);
      });

      test('uses full prices once upstream recovers', async () => {
        await fetchNl();
        advance(1);
        entsoe.mockImplementation(async () => entsoeXml(['2026-10-31']));

        const result = await fetchNl();

        expect(result.prices).toHaveLength(24);
        expect(result.warnings).toBeUndefined();
      });

      test('fails once those prices are from a previous day', async () => {
        await fetchNl();
        setClock('2026-11-01T07:00:00Z');

        await expect(fetchNl()).rejects.toThrow();
      });
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

  describe('cache stats', () => {
    test('report countries whose last refresh failed', async () => {
      await fetchNl();
      setClock('2026-10-31T13:31:00Z');
      entsoe.mockImplementation(async () => {
        throw new Error('ENTSOE 503');
      });
      await fetchNl();

      const stats = helpers.getCacheStats();
      expect(stats.staleCountries).toEqual(['nl']);
      expect(stats.failedCountries).toEqual([]);
    });

    test('report countries that are failing with nothing usable cached', async () => {
      entsoe.mockImplementation(async () => {
        throw new Error('ENTSOE 503');
      });
      await expect(fetchNl()).rejects.toThrow();

      const stats = helpers.getCacheStats();
      expect(stats.staleCountries).toEqual([]);
      expect(stats.failedCountries).toEqual(['nl']);
    });

    test('report neither once a refresh succeeds', async () => {
      entsoe.mockImplementationOnce(async () => {
        throw new Error('ENTSOE 503');
      });
      await expect(fetchNl()).rejects.toThrow();
      advance(1);
      await fetchNl();

      const stats = helpers.getCacheStats();
      expect(stats.staleCountries).toEqual([]);
      expect(stats.failedCountries).toEqual([]);
    });
  });

  describe('upstream call logging', () => {
    let originalFetch;
    let originalToken;

    beforeEach(() => {
      originalFetch = global.fetch;
      originalToken = process.env.LOGTAIL_TOKEN;
      global.fetch = jest.fn().mockResolvedValue({ ok: true });
      process.env.LOGTAIL_TOKEN = 'test-token';
      jest.isolateModules(() => {
        const { EntsoeAPI } = require('../entsoe');
        const { StekkerAPI } = require('../stekker');
        EntsoeAPI.prototype.makeRequest = (...args) => entsoe(...args);
        StekkerAPI.prototype.makeRequest = (...args) => stekker(...args);
        helpers = require('../utils/helpers');
      });
    });

    afterEach(() => {
      global.fetch = originalFetch;
      if (originalToken === undefined) delete process.env.LOGTAIL_TOKEN;
      else process.env.LOGTAIL_TOKEN = originalToken;
    });

    test('sends the source, country, duration and errors to the log, without the API key', async () => {
      entsoe.mockImplementation(async () => {
        throw new Error('ENTSOE 503');
      });
      stekker.mockImplementation(async () => stekkerHtml('2026-10-31'));

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
    });

    test('says when a fetched result was discarded in favour of cached prices', async () => {
      setClock('2026-10-31T14:00:00Z');
      entsoe.mockImplementation(async () => entsoeXml(['2026-10-31', '2026-11-01']));
      await fetchNl();

      setClock('2026-10-31T23:30:00Z');
      entsoe.mockImplementation(async () => entsoeXml([], 50, { '2026-11-01': 6 }));
      await fetchNl();
      await new Promise(resolve => setImmediate(resolve));

      const messages = global.fetch.mock.calls.map(call => JSON.parse(call[1].body).message);
      expect(messages).toEqual([
        'Upstream fetch: nl from entsoe',
        'Upstream fetch: nl from entsoe (result discarded, cached prices kept)'
      ]);
    });
  });
});
