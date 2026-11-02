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

const MINUTE = 60_000;
const NOW = '2026-10-31T17:00:00Z';
const TWO_DAYS = { start: '2026-10-30T23:00Z', end: '2026-11-01T23:00Z' };

function period({ start, end }, resolution, field, values) {
  const points = values.map((value, i) => `<Point><position>${i + 1}</position><${field}>${value}</${field}></Point>`);
  return `<Period>
    <timeInterval><start>${start}</start><end>${end}</end></timeInterval>
    <resolution>${resolution}</resolution>${points.join('')}
  </Period>`;
}

function slots({ start, end }, resolutionMinutes) {
  return Math.round((new Date(end) - new Date(start)) / (resolutionMinutes * MINUTE));
}

function pricesXml(range = TWO_DAYS, resolutionMinutes = 60) {
  const values = Array.from({ length: slots(range, resolutionMinutes) }, (_, i) => i + 1);
  const series = period(range, `PT${resolutionMinutes}M`, 'price.amount', values);
  return `<Publication_MarketDocument><TimeSeries>${series}</TimeSeries></Publication_MarketDocument>`;
}

function constant(range, resolutionMinutes, value) {
  return Array.from({ length: slots(range, resolutionMinutes) }, () => value);
}

function productionSeries(psrType, range, resolutionMinutes, values, domain = 'inBiddingZone_Domain.mRID') {
  return `<TimeSeries>
    <${domain}>zone</${domain}>
    <MktPSRType><psrType>${psrType}</psrType></MktPSRType>
    ${period(range, `PT${resolutionMinutes}M`, 'quantity', values)}
  </TimeSeries>`;
}

function glDocument(...series) {
  return `<GL_MarketDocument>${series.join('')}</GL_MarketDocument>`;
}

// 100 solar + 100 offshore + 300 onshore against a demand of 1000 is 50%.
function productionXml(range = TWO_DAYS, resolutionMinutes = 60) {
  return glDocument(
    productionSeries('B16', range, resolutionMinutes, constant(range, resolutionMinutes, 100)),
    productionSeries('B18', range, resolutionMinutes, constant(range, resolutionMinutes, 100)),
    productionSeries('B19', range, resolutionMinutes, constant(range, resolutionMinutes, 300))
  );
}

function loadXml(range = TWO_DAYS, resolutionMinutes = 60, load = 1000) {
  const series = period(range, `PT${resolutionMinutes}M`, 'quantity', constant(range, resolutionMinutes, load));
  return glDocument(`<TimeSeries><outBiddingZone_Domain.mRID>zone</outBiddingZone_Domain.mRID>${series}</TimeSeries>`);
}

describe('includeWindSolar', () => {
  let originalKey;
  let upstream;
  let fetchText;

  // Stubs HTTP rather than makeRequest, so the real request paths and deadlines are exercised.
  function loadApp() {
    let app;
    jest.isolateModules(() => {
      jest.doMock('../utils/httpClient', () => ({ fetchText }));
      app = require('../index');
    });
    return app;
  }

  function callsFor(documentType) {
    return fetchText.mock.calls.filter(([url]) => url.includes(`documentType=${documentType}`));
  }

  const ok = body => ({ status: 200, body });

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date(NOW), doNotFake: REAL_TIME_APIS });
    originalKey = process.env.ENTSOE_API_KEY;
    process.env.ENTSOE_API_KEY = 'test-key';
    upstream = { A44: () => ok(pricesXml()), A69: () => ok(productionXml()), A65: () => ok(loadXml()) };
    fetchText = jest.fn(async url => {
      const type = (url.match(/documentType=(\w+)/) || [])[1];
      if (!type) return { status: 503, body: 'stekker is down' };
      return upstream[type]();
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.dontMock('../utils/httpClient');
    process.env.ENTSOE_API_KEY = originalKey;
    if (originalKey === undefined) delete process.env.ENTSOE_API_KEY;
  });

  describe('without the parameter', () => {
    test.each(['', '?includeWindSolar=', '?includeWindSolar=false'])('%s adds and fetches nothing', async qs => {
      const { body } = await request(loadApp()).get(`/api/nl/next/6${qs}`).expect(200);

      expect(body.data[0]).not.toHaveProperty('windSolarShare');
      expect(body.warnings).toBeUndefined();
      expect(callsFor('A69')).toHaveLength(0);
      expect(callsFor('A65')).toHaveLength(0);
    });
  });

  describe('validation', () => {
    test.each(['maybe', '1'])('rejects %s', async value => {
      const { body } = await request(loadApp()).get(`/api/nl/today?includeWindSolar=${value}`).expect(400);
      expect(body.message).toMatch(/includeWindSolar/);
    });

    test('rejects a repeated value', async () => {
      await request(loadApp()).get('/api/nl/today?includeWindSolar=true&includeWindSolar=true').expect(400);
    });
  });

  describe.each(['/api/nl/today', '/api/nl/next24h', '/api/nl/next/6'])('%s', route => {
    test('gives each price the forecast wind and solar share of demand', async () => {
      const { body } = await request(loadApp()).get(`${route}?includeWindSolar=true`).expect(200);

      expect(body.data.length).toBeGreaterThan(0);
      expect(body.data.every(item => item.windSolarShare === 50)).toBe(true);
      expect(body.warnings).toBeUndefined();
    });
  });

  test('asks ENTSOE for the zone of the requested country', async () => {
    await request(loadApp()).get('/api/de/next/6?includeWindSolar=true').expect(200);

    expect(callsFor('A69')[0][0]).toContain('processType=A01&in_Domain=10Y1001A1001A82H');
    expect(callsFor('A65')[0][0]).toContain('processType=A01&outBiddingZone_Domain=10Y1001A1001A82H');
  });

  test('rounds to one decimal', async () => {
    upstream.A65 = () => ok(loadXml(TWO_DAYS, 60, 1500));
    const { body } = await request(loadApp()).get('/api/nl/next/6?includeWindSolar=true').expect(200);

    expect(body.data[0].windSolarShare).toBe(33.3);
  });

  test('is not capped at 100, because a zone can produce more than it uses', async () => {
    upstream.A65 = () => ok(loadXml(TWO_DAYS, 60, 400));
    const { body } = await request(loadApp()).get('/api/nl/next/6?includeWindSolar=true').expect(200);

    expect(body.data[0].windSolarShare).toBe(125);
  });

  test('ignores series that are not production in the zone', async () => {
    upstream.A69 = () =>
      ok(
        glDocument(
          productionSeries('B19', TWO_DAYS, 60, constant(TWO_DAYS, 60, 500)),
          productionSeries('B19', TWO_DAYS, 60, constant(TWO_DAYS, 60, 9000), 'outBiddingZone_Domain.mRID')
        )
      );
    const { body } = await request(loadApp()).get('/api/nl/next/6?includeWindSolar=true').expect(200);

    expect(body.data[0].windSolarShare).toBe(50);
  });

  describe('resolution', () => {
    const QUARTERS = { start: '2026-10-31T17:00Z', end: '2026-10-31T18:00Z' };

    function quarterShares(...production) {
      return () => ok(glDocument(productionSeries('B19', QUARTERS, 15, production)));
    }

    test('an hourly price gets the mean of its quarter-hour shares', async () => {
      upstream.A69 = quarterShares(100, 200, 300, 400);
      upstream.A65 = () => ok(loadXml(TWO_DAYS, 15));
      const { body } = await request(loadApp()).get('/api/nl/next/1?includeWindSolar=true').expect(200);

      expect(body.data).toHaveLength(1);
      expect(body.data[0].windSolarShare).toBe(25);
    });

    test('a quarter-hour price gets its own share', async () => {
      upstream.A44 = () => ok(pricesXml(TWO_DAYS, 15));
      upstream.A69 = quarterShares(100, 200, 300, 400);
      upstream.A65 = () => ok(loadXml(TWO_DAYS, 15));
      const { body } = await request(loadApp()).get('/api/nl/next/1?interval=15M&includeWindSolar=true').expect(200);

      expect(body.data.map(item => item.windSolarShare)).toEqual([10, 20, 30, 40]);
    });

    test('a quarter-hour price takes the value of an hourly forecast', async () => {
      upstream.A44 = () => ok(pricesXml(TWO_DAYS, 15));
      const { body } = await request(loadApp()).get('/api/nl/next/1?interval=15M&includeWindSolar=true').expect(200);

      expect(body.data.map(item => item.windSolarShare)).toEqual([50, 50, 50, 50]);
    });

    test('mixed resolutions between production types still add up', async () => {
      upstream.A69 = () =>
        ok(
          glDocument(
            productionSeries('B16', TWO_DAYS, 60, constant(TWO_DAYS, 60, 100)),
            productionSeries('B19', TWO_DAYS, 15, constant(TWO_DAYS, 15, 400))
          )
        );
      const { body } = await request(loadApp()).get('/api/nl/next/1?includeWindSolar=true').expect(200);

      expect(body.data[0].windSolarShare).toBe(50);
    });

    test('forward-fills points omitted by ENTSOE', async () => {
      upstream.A69 = () =>
        ok(
          glDocument(`<TimeSeries><inBiddingZone_Domain.mRID>zone</inBiddingZone_Domain.mRID>
            <MktPSRType><psrType>B19</psrType></MktPSRType>
            ${period(TWO_DAYS, 'PT60M', 'quantity', [500])}
          </TimeSeries>`)
        );
      const { body } = await request(loadApp()).get('/api/nl/next/6?includeWindSolar=true').expect(200);

      expect(body.data.every(item => item.windSolarShare === 50)).toBe(true);
    });
  });

  describe('missing forecasts', () => {
    const TODAY = { start: '2026-10-30T23:00Z', end: '2026-10-31T23:00Z' };
    const AFTER_TODAY = '2026-10-31T23:00:00.000Z';

    test('prices with no production forecast yet get null, without a warning', async () => {
      upstream.A69 = () => ok(productionXml(TODAY));
      const { body } = await request(loadApp()).get('/api/nl/next24h?includeWindSolar=true').expect(200);

      expect(body.data.find(item => item.time === '2026-10-31T17:00:00.000Z').windSolarShare).toBe(50);
      expect(body.data.find(item => item.time === AFTER_TODAY).windSolarShare).toBeNull();
      expect(body.warnings).toBeUndefined();
    });

    test('prices with no demand forecast yet get null', async () => {
      upstream.A65 = () => ok(loadXml(TODAY));
      const { body } = await request(loadApp()).get('/api/nl/next24h?includeWindSolar=true').expect(200);

      expect(body.data.find(item => item.time === AFTER_TODAY).windSolarShare).toBeNull();
    });

    // ENTSOE had DE offshore wind for hours where solar and onshore were still missing, which would read far too low.
    test('a slot missing one production type gets null rather than a partial sum', async () => {
      upstream.A69 = () =>
        ok(
          glDocument(
            productionSeries('B16', TODAY, 60, constant(TODAY, 60, 100)),
            productionSeries('B18', TWO_DAYS, 60, constant(TWO_DAYS, 60, 100)),
            productionSeries('B19', TODAY, 60, constant(TODAY, 60, 300))
          )
        );
      const { body } = await request(loadApp()).get('/api/nl/next24h?includeWindSolar=true').expect(200);

      expect(body.data.find(item => item.time === AFTER_TODAY).windSolarShare).toBeNull();
    });

    test('an hourly price missing one of its quarters gets null', async () => {
      const threeQuarters = { start: '2026-10-31T17:00Z', end: '2026-10-31T17:45Z' };
      upstream.A69 = () => ok(glDocument(productionSeries('B19', threeQuarters, 15, [500, 500, 500])));
      const { body } = await request(loadApp()).get('/api/nl/next/1?includeWindSolar=true').expect(200);

      expect(body.data[0].windSolarShare).toBeNull();
    });

    test('zero demand gets null rather than infinity', async () => {
      upstream.A65 = () => ok(loadXml(TWO_DAYS, 60, 0));
      const { body } = await request(loadApp()).get('/api/nl/next/1?includeWindSolar=true').expect(200);

      expect(body.data[0].windSolarShare).toBeNull();
    });
  });

  test('covers all 25 hours of the day the clocks go back', async () => {
    jest.setSystemTime(new Date('2026-10-25T12:00:00Z'));
    const range = { start: '2026-10-24T22:00Z', end: '2026-10-26T23:00Z' };
    upstream.A44 = () => ok(pricesXml(range));
    upstream.A69 = () => ok(productionXml(range));
    upstream.A65 = () => ok(loadXml(range));
    const { body } = await request(loadApp()).get('/api/nl/today?includeWindSolar=true').expect(200);

    expect(body.data).toHaveLength(25);
    expect(body.data.every(item => item.windSolarShare === 50)).toBe(true);
  });

  describe('prices come first', () => {
    const WARNING = 'wind_solar_unavailable';

    test.each(['A69', 'A65'])('%s failing leaves prices intact, with null and a warning', async type => {
      upstream[type] = () => ({ status: 500, body: '<text>down</text>' });
      const app = loadApp();
      const { body } = await request(app).get('/api/nl/next/6?includeWindSolar=true').expect(200);
      const plain = await request(app).get('/api/nl/next/6').expect(200);

      expect(body.data.map(item => item.price)).toEqual(plain.body.data.map(item => item.price));
      expect(body.data.every(item => item.windSolarShare === null)).toBe(true);
      expect(body.warnings).toEqual([expect.stringContaining(WARNING)]);
    });

    test('a connection error or timeout does the same', async () => {
      upstream.A69 = () => {
        throw new Error('Request timed out after 5000ms');
      };
      const { body } = await request(loadApp()).get('/api/nl/next/6?includeWindSolar=true').expect(200);

      expect(body.data[0].windSolarShare).toBeNull();
      expect(body.warnings).toEqual([expect.stringContaining(WARNING)]);
    });

    test('an acknowledgement instead of data does the same', async () => {
      upstream.A65 = () =>
        ok(
          '<Acknowledgement_MarketDocument><Reason><code>999</code><text>No matching data</text></Reason>' +
            '</Acknowledgement_MarketDocument>'
        );
      const { body } = await request(loadApp()).get('/api/nl/next/6?includeWindSolar=true').expect(200);

      expect(body.warnings).toEqual([expect.stringContaining(WARNING)]);
    });

    test('keeps existing warnings alongside its own', async () => {
      process.env.ENTSOE_API_KEY = '';
      const start = new Date('2026-10-30T23:00:00Z').getTime();
      const x = Array.from({ length: 48 }, (_, i) => new Date(start + i * 60 * MINUTE).toISOString());
      const graph = JSON.stringify([{ name: 'Market price', x, y: x.map(() => 70) }]).replace(/"/g, '&quot;');
      fetchText.mockImplementation(async () => ({
        status: 200,
        body: `<div data-epex-forecast-graph-data-value="${graph}">price</div>`
      }));
      const { body } = await request(loadApp()).get('/api/nl/next/6?includeWindSolar=true').expect(200);

      expect(body.info.source).toBe('stekker');
      expect(body.warnings).toEqual([expect.stringContaining('fallback_source'), expect.stringContaining(WARNING)]);
      expect(callsFor('A69')).toHaveLength(0);
    });

    test('forecast fetches have their own deadline, and prices keep theirs', async () => {
      await request(loadApp()).get('/api/nl/next/6?includeWindSolar=true').expect(200);

      expect(callsFor('A69')[0][1].timeoutMs).toBe(30000);
      expect(callsFor('A65')[0][1].timeoutMs).toBe(30000);
      expect(callsFor('A44')[0][1].timeoutMs).toBe(22000);
    });

    // ENTSOE can take far longer than a request should wait, so the fetch carries on and serves later requests.
    test('a slow forecast answers after 5 seconds, then fills the cache', async () => {
      let releaseLoad;
      upstream.A65 = () =>
        new Promise(resolve => {
          releaseLoad = () => resolve(ok(loadXml()));
        });
      const app = loadApp();

      const started = performance.now();
      const first = await request(app).get('/api/nl/next/6?includeWindSolar=true').expect(200);
      const waited = performance.now() - started;

      expect(waited).toBeGreaterThan(4900);
      expect(waited).toBeLessThan(7000);
      expect(first.body.data[0].windSolarShare).toBeNull();
      expect(first.body.warnings).toEqual([expect.stringContaining(WARNING)]);

      releaseLoad();
      await new Promise(resolve => setTimeout(resolve, 20));
      const second = await request(app).get('/api/nl/next/6?includeWindSolar=true').expect(200);

      expect(second.body.data[0].windSolarShare).toBe(50);
      expect(second.body.warnings).toBeUndefined();
      expect(callsFor('A69')).toHaveLength(1);
    });

    test('doing its fetch alongside prices, so the wait adds no time to a slow price fetch', async () => {
      let releasePrices;
      upstream.A44 = () =>
        new Promise(resolve => {
          releasePrices = () => resolve(ok(pricesXml()));
        });
      const pending = request(loadApp()).get('/api/nl/next/6?includeWindSolar=true').then(res => res);
      for (let tries = 0; tries < 100 && !(releasePrices && callsFor('A69').length); tries += 1) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      const forecastCallsWhilePricesPending = callsFor('A69').length;

      releasePrices();
      expect((await pending).status).toBe(200);
      expect(forecastCallsWhilePricesPending).toBe(1);
    });

    test('a price failure is still a 503', async () => {
      upstream.A44 = () => ({ status: 500, body: '<text>down</text>' });
      const { status } = await request(loadApp()).get('/api/nl/next/6?includeWindSolar=true');

      expect(status).toBe(503);
    });

    test('never returns the ENTSOE error text in the warning', async () => {
      upstream.A69 = () => ({ status: 500, body: '<text>secret detail</text>' });
      const { body } = await request(loadApp()).get('/api/nl/next/6?includeWindSolar=true').expect(200);

      expect(JSON.stringify(body)).not.toContain('secret detail');
    });
  });

  describe('caching', () => {
    const url = '/api/nl/next/6?includeWindSolar=true';

    test('concurrent requests share one fetch per forecast', async () => {
      const app = loadApp();
      await Promise.all([request(app).get(url), request(app).get(url), request(app).get(url)]);

      expect(callsFor('A69')).toHaveLength(1);
      expect(callsFor('A65')).toHaveLength(1);
    });

    test('keeps a result for an hour, then fetches again', async () => {
      const app = loadApp();
      await request(app).get(url).expect(200);

      jest.setSystemTime(new Date(new Date(NOW).getTime() + 59 * MINUTE));
      await request(app).get(url).expect(200);
      expect(callsFor('A69')).toHaveLength(1);

      jest.setSystemTime(new Date(new Date(NOW).getTime() + 60 * MINUTE));
      await request(app).get(url).expect(200);
      expect(callsFor('A69')).toHaveLength(2);
    });

    test('retries a failure after 5 minutes rather than on every request', async () => {
      upstream.A69 = () => ({ status: 500, body: '<text>down</text>' });
      const app = loadApp();
      await request(app).get(url).expect(200);

      jest.setSystemTime(new Date(new Date(NOW).getTime() + 4 * MINUTE));
      await request(app).get(url).expect(200);
      expect(callsFor('A69')).toHaveLength(1);

      upstream.A69 = () => ok(productionXml());
      jest.setSystemTime(new Date(new Date(NOW).getTime() + 5 * MINUTE));
      const { body } = await request(app).get(url).expect(200);
      expect(callsFor('A69')).toHaveLength(2);
      expect(body.data[0].windSolarShare).toBe(50);
      expect(body.warnings).toBeUndefined();
    });

    // TRMNL polls every two hours, so it would otherwise find an expired entry and wait on nearly every poll.
    describe('an expired forecast', () => {
      const HOUR = 60 * MINUTE;
      const advance = hours => jest.setSystemTime(new Date(new Date(NOW).getTime() + hours * HOUR));

      function pendingProduction() {
        let release;
        upstream.A69 = () =>
          new Promise(resolve => {
            release = () => resolve(ok(productionXml()));
          });
        return () => release();
      }

      test('is served at once while a slow refresh runs, and the refresh serves later requests', async () => {
        const app = loadApp();
        await request(app).get(url).expect(200);

        advance(2);
        const release = pendingProduction();
        upstream.A65 = () => ok(loadXml(TWO_DAYS, 60, 2000));
        const started = performance.now();
        const stale = await request(app).get(url).expect(200);

        expect(performance.now() - started).toBeLessThan(2000);
        expect(stale.body.data[0].windSolarShare).toBe(50);
        expect(stale.body.warnings).toBeUndefined();
        expect(callsFor('A69')).toHaveLength(2);

        release();
        await new Promise(resolve => setTimeout(resolve, 20));
        const fresh = await request(app).get(url).expect(200);
        expect(fresh.body.data[0].windSolarShare).toBe(25);
        expect(callsFor('A69')).toHaveLength(2);
      });

      test('is not served after a refresh has failed', async () => {
        const app = loadApp();
        await request(app).get(url).expect(200);

        advance(2);
        upstream.A69 = () => ({ status: 500, body: '<text>down</text>' });
        await request(app).get(url).expect(200);
        await new Promise(resolve => setTimeout(resolve, 20));
        const { body } = await request(app).get(url).expect(200);

        expect(body.data[0].windSolarShare).toBeNull();
        expect(body.warnings).toEqual([expect.stringContaining('wind_solar_unavailable')]);
        expect(callsFor('A69')).toHaveLength(2);
      });

      test('is served up to 6 hours old', async () => {
        const app = loadApp();
        await request(app).get(url).expect(200);

        advance(5.9);
        pendingProduction();
        const { body } = await request(app).get(url).expect(200);
        expect(body.data[0].windSolarShare).toBe(50);
      });

      test('is not served beyond 6 hours old', async () => {
        const app = loadApp();
        await request(app).get(url).expect(200);

        advance(6);
        pendingProduction();
        const { body } = await request(app).get(url).expect(200);
        expect(body.data[0].windSolarShare).toBeNull();
        expect(body.warnings).toEqual([expect.stringContaining('wind_solar_unavailable')]);
      });
    });

    test('keeps countries apart', async () => {
      const app = loadApp();
      await request(app).get(url).expect(200);
      await request(app).get('/api/de/next/6?includeWindSolar=true').expect(200);

      expect(callsFor('A69')).toHaveLength(2);
    });

    test('markup and VAT do not change the share or cause another fetch', async () => {
      const app = loadApp();
      await request(app).get(url).expect(200);
      const { body } = await request(app).get(`${url}&markup=0.1&vat=0.21`).expect(200);

      expect(body.data[0].windSolarShare).toBe(50);
      expect(callsFor('A69')).toHaveLength(1);
    });
  });
});
