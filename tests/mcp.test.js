// Upstream HTTP is stubbed at makeRequest; only Date is faked so promises and real timers keep working.
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
const NOV_2 = '2026-11-02';
const NOV_3 = '2026-11-03';
const LEGACY_VERSION = '2025-06-18';
const MODERN_VERSION = '2026-07-28';

// All dates are in CET. A local NL day starts at 23:00Z the day before.
function dayStartUtc(day) {
  return new Date(new Date(`${day}T00:00:00Z`).getTime() - 60 * MINUTE);
}

// Prices in EUR/MWh: 300 all day, with 200 from 12:15 to 16:15 local, and 100 from 23:00 local.
function quarterPrice(index) {
  if (index >= 92) return 100;
  return index >= 49 && index <= 64 ? 200 : 300;
}

function entsoeXml(days, priceAt = quarterPrice) {
  const series = days.map(day => {
    const start = dayStartUtc(day);
    const end = new Date(start.getTime() + 96 * 15 * MINUTE);
    const format = date => `${date.toISOString().slice(0, 16)}Z`;
    const points = Array.from(
      { length: 96 },
      (_, i) => `<Point><position>${i + 1}</position><price.amount>${priceAt(i, day)}</price.amount></Point>`
    );
    return `<TimeSeries><Period>
      <timeInterval><start>${format(start)}</start><end>${format(end)}</end></timeInterval>
      <resolution>PT15M</resolution>
      ${points.join('')}
    </Period></TimeSeries>`;
  });
  return `<Publication_MarketDocument>${series.join('')}</Publication_MarketDocument>`;
}

describe('POST /mcp', () => {
  let app;
  let entsoe;

  function start(now, xml = () => entsoeXml([NOV_2])) {
    jest.setSystemTime(new Date(now));
    entsoe.mockImplementation(async () => xml());
  }

  function textParser(res, callback) {
    res.setEncoding('utf8');
    let body = '';
    res.on('data', chunk => {
      body += chunk;
    });
    res.on('end', () => callback(null, body));
  }

  // 2025-era clients get a short event stream, 2026-era clients plain JSON.
  function parseReply(response) {
    if (!response.headers['content-type']?.includes('text/event-stream')) return JSON.parse(response.body);
    const data = response.body.split('\n').find(line => line.startsWith('data: {'));
    return JSON.parse(data.slice('data: '.length));
  }

  const post = (body, version = LEGACY_VERSION) =>
    request(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('MCP-Protocol-Version', version)
      .send(body)
      .buffer(true)
      .parse(textParser);

  const rpc = (method, params = {}) => post({ jsonrpc: '2.0', id: 1, method, params });

  async function callTool(name, args) {
    const response = await rpc('tools/call', { name, arguments: args }).expect(200);
    return parseReply(response).result;
  }

  async function toolData(name, args) {
    const result = await callTool(name, args);
    expect(result.isError).toBeFalsy();
    return JSON.parse(result.content[0].text);
  }

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-11-02T08:00:00Z'), doNotFake: REAL_TIME_APIS });
    process.env.ENTSOE_API_KEY = 'test-key';
    entsoe = jest.fn();
    jest.isolateModules(() => {
      const { EntsoeAPI } = require('../entsoe');
      const { StekkerAPI } = require('../stekker');
      EntsoeAPI.prototype.makeRequest = (...args) => entsoe(...args);
      StekkerAPI.prototype.makeRequest = async () => {
        throw new Error('HTTP 503');
      };
      app = require('../index');
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.ENTSOE_API_KEY;
  });

  describe('protocol', () => {
    test('a client can initialize without a session', async () => {
      const response = await rpc('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' }
      }).expect(200);

      const { result } = parseReply(response);
      expect(response.headers['mcp-session-id']).toBeUndefined();
      expect(result.serverInfo.name).toBe('eu-day-ahead-prices');
      expect(result.instructions).toContain('country');
    });

    test('lists the three read-only tools', async () => {
      const { result } = parseReply(await rpc('tools/list').expect(200));

      const names = result.tools.map(tool => tool.name).sort();
      expect(names).toEqual(['find_cheapest_window', 'get_prices', 'list_countries']);
      for (const tool of result.tools) expect(tool.annotations.readOnlyHint).toBe(true);
    });

    test('country is required, and the description says to ask for it', async () => {
      const { result } = parseReply(await rpc('tools/list').expect(200));

      const tool = result.tools.find(({ name }) => name === 'find_cheapest_window');
      expect(tool.inputSchema.required).toEqual(expect.arrayContaining(['country', 'hours']));
      expect(tool.inputSchema.properties.country.description).toMatch(/ask/i);
    });

    test('a current client gets plain JSON', async () => {
      const response = await post(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {
            _meta: {
              'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
              'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
              'io.modelcontextprotocol/clientCapabilities': {}
            }
          }
        },
        MODERN_VERSION
      )
        .set('MCP-Method', 'tools/list')
        .expect(200);

      expect(response.headers['content-type']).toContain('application/json');
      expect(parseReply(response).result.tools).toHaveLength(3);
    });

    test('GET is not supported', async () => {
      await request(app).get('/mcp').set('MCP-Protocol-Version', LEGACY_VERSION).expect(405);
    });

    test('rejects an oversized request', async () => {
      await rpc('tools/list', { padding: 'x'.repeat(70 * 1024) }).expect(413);
    });

    test('refuses a batch, which would get past the rate limit', async () => {
      start('2026-11-02T08:00:00Z');
      const call = id => ({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'get_prices', arguments: { country: 'nl' } }
      });

      const response = await post([call(1), call(2)]);

      expect(response.status).toBe(400);
      expect(response.body).not.toContain('pricePerKwh');
    });

    test('refuses a listen stream, because the tools never change', async () => {
      const response = await post(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'subscriptions/listen',
          params: {
            _meta: {
              'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
              'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
              'io.modelcontextprotocol/clientCapabilities': {}
            },
            notifications: { toolsListChanged: true }
          }
        },
        MODERN_VERSION
      )
        .set('MCP-Method', 'subscriptions/listen')
        .timeout(3000);

      expect(parseReply(response).error.code).toBe(-32603);
    });

    test('rejects malformed JSON', async () => {
      await request(app).post('/mcp').set('Content-Type', 'application/json').send('{not json').expect(400);
    });

    test('is rate limited', async () => {
      const response = await rpc('tools/list').expect(200);

      expect(response.headers['x-ratelimit-limit']).toBeDefined();
    });
  });

  describe('find_cheapest_window', () => {
    test('answers the dishwasher question in local time', async () => {
      start('2026-11-02T08:00:00Z');

      expect(await toolData('find_cheapest_window', { country: 'nl', hours: 4 })).toEqual({
        available: true,
        country: 'Netherlands',
        timezone: 'Europe/Amsterdam',
        checkedAt: '2026-11-02T09:00+01:00',
        hours: 4,
        start: '2026-11-02T12:15+01:00',
        end: '2026-11-02T16:15+01:00',
        averagePricePerKwh: 0.2,
        currency: 'EUR',
        priceBasis: 'excluding markup and VAT',
        dataSource: 'ENTSOE Transparency Platform'
      });
    });

    test('ignores a cheaper window that has already passed', async () => {
      start('2026-11-02T15:00:00Z', () => entsoeXml([NOV_2], i => (i <= 32 ? 50 : 300)));

      const data = await toolData('find_cheapest_window', { country: 'nl', hours: 4 });

      expect(data.start).toBe('2026-11-02T16:00+01:00');
    });

    test('at 20:00 the window can run past midnight', async () => {
      start('2026-11-02T19:00:00Z', () =>
        entsoeXml([NOV_2, NOV_3], (i, day) => {
          if (day === NOV_2) return quarterPrice(i);
          return i < 12 ? 100 : 300;
        })
      );

      const data = await toolData('find_cheapest_window', { country: 'nl', hours: 4 });

      expect(data.start).toBe('2026-11-02T23:00+01:00');
      expect(data.end).toBe('2026-11-03T03:00+01:00');
    });

    test('tomorrow from 7am', async () => {
      start('2026-11-02T19:00:00Z', () =>
        entsoeXml([NOV_2, NOV_3], (i, day) => (day === NOV_3 && i < 28 ? 50 : quarterPrice(i)))
      );

      const data = await toolData('find_cheapest_window', { country: 'nl', hours: 4, day: 'tomorrow', from: 7 });

      expect(data.start).toBe('2026-11-03T12:15+01:00');
    });

    test('says when it rounded the length up to the price steps', async () => {
      start('2026-11-02T08:00:00Z');

      const data = await toolData('find_cheapest_window', { country: 'nl', hours: 3.1 });

      expect(data.hours).toBe(3.25);
      expect(data.requestedHours).toBe(3.1);
    });

    test('says when tomorrow is not published yet', async () => {
      start('2026-11-02T08:00:00Z');

      const data = await toolData('find_cheapest_window', { country: 'nl', hours: 4, day: 'tomorrow' });

      expect(data.available).toBe(false);
      expect(data.reason).toMatch(/tomorrow.*published/i);
      expect(data.reason).toContain('14:30');
    });

    test('says when nothing fits the rest of today', async () => {
      start('2026-11-02T22:00:00Z');

      const data = await toolData('find_cheapest_window', { country: 'nl', hours: 4 });

      expect(data.available).toBe(false);
      expect(data.reason).toMatch(/fits/);
    });

    test('markup and VAT change the price but not the window', async () => {
      start('2026-11-02T08:00:00Z');

      const data = await toolData('find_cheapest_window', { country: 'nl', hours: 4, markup: 0.1, includeVat: true });

      expect(data.requestedHours).toBeUndefined();
      expect(data.start).toBe('2026-11-02T12:15+01:00');
      expect(data.averagePricePerKwh).toBeCloseTo(0.363, 4);
      expect(data.priceBasis).toBe('including your markup and VAT');
    });

    test('an upstream failure is a tool error without internal details', async () => {
      start('2026-11-02T08:00:00Z', () => {
        throw new Error('secret upstream detail');
      });

      const result = await callTool('find_cheapest_window', { country: 'nl', hours: 4 });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).not.toContain('secret');
    });

    test.each([
      [{ hours: 4 }],
      [{ country: 'xx', hours: 4 }],
      [{ country: 'nl' }],
      [{ country: 'nl', hours: 0 }],
      [{ country: 'nl', hours: 25 }],
      [{ country: 'nl', hours: 4, from: 24 }],
      [{ country: 'nl', hours: 4, to: 0 }],
      [{ country: 'nl', hours: 4, day: 'friday' }]
    ])('rejects %j without calling upstream', async args => {
      start('2026-11-02T08:00:00Z');

      const result = await callTool('find_cheapest_window', args);

      expect(result.isError).toBe(true);
      expect(entsoe).not.toHaveBeenCalled();
    });

    test('rejects a markup out of range with the reason', async () => {
      start('2026-11-02T08:00:00Z');

      const result = await callTool('find_cheapest_window', { country: 'nl', hours: 4, markup: 100 });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('markup');
    });
  });

  describe('get_prices', () => {
    test('returns today by the hour by default', async () => {
      start('2026-11-02T08:00:00Z');

      const data = await toolData('get_prices', { country: 'nl' });

      expect(data.prices).toHaveLength(24);
      expect(data.prices[0]).toEqual({ time: '2026-11-02T00:00+01:00', pricePerKwh: 0.3 });
      expect(data.priceBasis).toBe('excluding markup and VAT');
    });

    test('can return quarter hours', async () => {
      start('2026-11-02T08:00:00Z');

      const data = await toolData('get_prices', { country: 'nl', interval: '15M' });

      expect(data.prices).toHaveLength(96);
    });

    test('nextHours starts at the current hour', async () => {
      start('2026-11-02T08:20:00Z');

      const data = await toolData('get_prices', { country: 'nl', nextHours: 2 });

      expect(data.prices.map(({ time }) => time)).toEqual(['2026-11-02T09:00+01:00', '2026-11-02T10:00+01:00']);
    });

    test('rejects an unknown country', async () => {
      const result = await callTool('get_prices', { country: 'xx' });

      expect(result.isError).toBe(true);
    });
  });

  test('list_countries gives codes, names and default VAT', async () => {
    const { countries } = await toolData('list_countries', {});

    expect(countries).toContainEqual({
      code: 'nl',
      name: 'Netherlands',
      timezone: 'Europe/Amsterdam',
      currency: 'EUR',
      defaultVat: 0.21
    });
  });
});
