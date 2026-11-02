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
const FEED = '/api/nl/calendar.ics';
const BEFORE_PUBLICATION = '2026-11-02T08:00:00Z';
const AFTER_PUBLICATION = '2026-11-02T15:00:00Z';

// All dates are in CET. A local NL day starts at 23:00Z the day before.
function dayStartUtc(day) {
  return new Date(new Date(`${day}T00:00:00Z`).getTime() - 60 * MINUTE);
}

// Prices in EUR/MWh: 300 all day, with 200 from 12:15 to 16:15 local.
function quarterPrice(index) {
  return index >= 49 && index <= 64 ? 200 : 300;
}

function entsoeXml(days, quartersByDay = {}) {
  const series = days.map(day => {
    const count = quartersByDay[day] ?? 96;
    const start = dayStartUtc(day);
    const end = new Date(start.getTime() + count * 15 * MINUTE);
    const format = date => `${date.toISOString().slice(0, 16)}Z`;
    const points = Array.from(
      { length: count },
      (_, i) => `<Point><position>${i + 1}</position><price.amount>${quarterPrice(i)}</price.amount></Point>`
    );
    return `<TimeSeries><Period>
      <timeInterval><start>${format(start)}</start><end>${format(end)}</end></timeInterval>
      <resolution>PT15M</resolution>
      ${points.join('')}
    </Period></TimeSeries>`;
  });
  return `<Publication_MarketDocument>${series.join('')}</Publication_MarketDocument>`;
}

function stekkerHtml(day) {
  const start = dayStartUtc(day).getTime();
  const x = Array.from({ length: 24 }, (_, i) => new Date(start + i * 60 * MINUTE).toISOString());
  const y = x.map((_, i) => (i >= 12 && i < 16 ? 200 : 300));
  const json = JSON.stringify([{ name: 'Market price', x, y }]).replace(/"/g, '&quot;');
  return `<div data-epex-forecast-graph-data-value="${json}">price</div>`;
}

const unfold = text => text.replace(/\r\n /g, '');
const eventLines = (text, key) =>
  unfold(text)
    .split('\r\n')
    .filter(line => line.startsWith(`${key}:`))
    .map(line => line.slice(key.length + 1));

describe('GET /api/:country/calendar.ics', () => {
  let app;
  let entsoe;
  let stekker;
  let originalKey;

  function start(now, responses = () => entsoeXml(['2026-11-02'])) {
    jest.setSystemTime(new Date(now));
    entsoe.mockImplementation(async () => responses());
  }

  const get = (query = '') => request(app).get(`${FEED}${query}`).buffer(true).parse(textParser);

  function textParser(res, callback) {
    res.setEncoding('utf8');
    let body = '';
    res.on('data', chunk => {
      body += chunk;
    });
    res.on('end', () => callback(null, body));
  }

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date(BEFORE_PUBLICATION), doNotFake: REAL_TIME_APIS });
    originalKey = process.env.ENTSOE_API_KEY;
    process.env.ENTSOE_API_KEY = 'test-key';

    entsoe = jest.fn();
    stekker = jest.fn(async () => {
      throw new Error('HTTP 503');
    });
    jest.isolateModules(() => {
      const { EntsoeAPI } = require('../entsoe');
      const { StekkerAPI } = require('../stekker');
      EntsoeAPI.prototype.makeRequest = (...args) => entsoe(...args);
      StekkerAPI.prototype.makeRequest = (...args) => stekker(...args);
      app = require('../index');
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    if (originalKey === undefined) delete process.env.ENTSOE_API_KEY;
    else process.env.ENTSOE_API_KEY = originalKey;
  });

  test('responds with a calendar file', async () => {
    start(BEFORE_PUBLICATION);

    const response = await get().expect(200);

    expect(response.headers['content-type']).toBe('text/calendar; charset=utf-8');
    expect(response.body).toMatch(/^BEGIN:VCALENDAR\r\n/);
  });

  test('the window follows the quarter-hour prices', async () => {
    start(BEFORE_PUBLICATION);

    const { body } = await get().expect(200);

    expect(eventLines(body, 'DTSTART')).toEqual(['20261102T111500Z']);
    expect(eventLines(body, 'DTEND')).toEqual(['20261102T151500Z']);
    expect(eventLines(body, 'SUMMARY')).toEqual(['Cheapest 4h · avg €0.20/kWh']);
  });

  test('hours sets the window length', async () => {
    start(BEFORE_PUBLICATION);

    const { body } = await get('?hours=2').expect(200);

    expect(eventLines(body, 'SUMMARY')[0]).toContain('Cheapest 2h');
    expect(eventLines(body, 'DTEND')).toEqual(['20261102T131500Z']);
  });

  test('the average includes markup and VAT', async () => {
    start(BEFORE_PUBLICATION);

    const { body } = await get('?markup=0.1&vat=auto').expect(200);

    // (0.20 + 0.10) * 1.21
    expect(eventLines(body, 'SUMMARY')).toEqual(['Cheapest 4h · avg €0.36/kWh']);
    expect(unfold(body)).toContain('your markup and VAT');
  });

  test('with only VAT, the description does not mention your markup', async () => {
    start(BEFORE_PUBLICATION);

    const { body } = await get('?vat=auto').expect(200);

    expect(unfold(body)).toContain('including VAT\\, excluding markup');
  });

  test('the description says when the price is the bare market price', async () => {
    start(BEFORE_PUBLICATION);

    const { body } = await get().expect(200);

    expect(unfold(body)).toContain('excluding markup and VAT');
  });

  test('from and to limit the search', async () => {
    start(BEFORE_PUBLICATION);

    const { body } = await get('?from=17&to=22').expect(200);

    expect(eventLines(body, 'DTSTART')).toEqual(['20261102T160000Z']);
  });

  test('credits the data source', async () => {
    start(BEFORE_PUBLICATION);

    const { body } = await get().expect(200);

    expect(unfold(body)).toContain('ENTSOE Transparency Platform');
  });

  describe('which days appear', () => {
    test('only today before the next day is published', async () => {
      start(BEFORE_PUBLICATION);

      const { body } = await get().expect(200);

      expect(eventLines(body, 'DTSTART')).toHaveLength(1);
    });

    test('today and tomorrow once it is published', async () => {
      start(AFTER_PUBLICATION, () => entsoeXml(['2026-11-02', '2026-11-03']));

      const { body } = await get().expect(200);

      expect(eventLines(body, 'DTSTART')).toEqual(['20261102T111500Z', '20261103T111500Z']);
    });

    test('today stays after its window has passed', async () => {
      start('2026-11-02T20:00:00Z', () => entsoeXml(['2026-11-02', '2026-11-03']));

      const { body } = await get().expect(200);

      expect(eventLines(body, 'DTSTART')[0]).toBe('20261102T111500Z');
    });

    test('a day with missing prices gets no event', async () => {
      start(AFTER_PUBLICATION, () => entsoeXml(['2026-11-02', '2026-11-03'], { '2026-11-03': 40 }));

      const { body } = await get().expect(200);

      expect(eventLines(body, 'DTSTART')).toEqual(['20261102T111500Z']);
    });
  });

  describe('event identity', () => {
    test('a day keeps its ID when its prices change', async () => {
      start(BEFORE_PUBLICATION);
      const before = await get().expect(200);

      jest.setSystemTime(new Date('2026-11-02T15:00:00Z'));
      entsoe.mockImplementation(async () => entsoeXml(['2026-11-02', '2026-11-03']));
      await get(); // Served while the refresh runs.
      await new Promise(resolve => setImmediate(resolve));
      const after = await get().expect(200);

      expect(eventLines(after.body, 'UID')[0]).toBe(eventLines(before.body, 'UID')[0]);
    });

    test('days have different IDs', async () => {
      start(AFTER_PUBLICATION, () => entsoeXml(['2026-11-02', '2026-11-03']));

      const { body } = await get().expect(200);

      const [first, second] = eventLines(body, 'UID');
      expect(first).not.toBe(second);
    });

    test('different window settings have different IDs', async () => {
      start(BEFORE_PUBLICATION);

      const fourHours = await get('?hours=4').expect(200);
      const threeHours = await get('?hours=3').expect(200);
      const daytime = await get('?hours=4&from=7&to=22').expect(200);

      const ids = [fourHours, threeHours, daytime].map(({ body }) => eventLines(body, 'UID')[0]);
      expect(new Set(ids).size).toBe(3);
    });
  });

  test('an unchanged feed answers conditional requests with 304', async () => {
    start(BEFORE_PUBLICATION);
    const first = await get().expect(200);

    jest.setSystemTime(new Date('2026-11-02T08:30:00Z'));

    await request(app).get(FEED).set('If-None-Match', first.headers.etag).expect(304);
  });

  describe('fallback data', () => {
    beforeEach(() => {
      stekker.mockImplementation(async () => stekkerHtml('2026-11-02'));
    });

    function startWithoutEntsoe() {
      start(BEFORE_PUBLICATION, () => {
        throw new Error('HTTP 503');
      });
    }

    test('windows start on the hour', async () => {
      startWithoutEntsoe();

      const { body } = await get().expect(200);

      expect(eventLines(body, 'DTSTART')).toEqual(['20261102T110000Z']);
    });

    test('the description says so', async () => {
      startWithoutEntsoe();

      const { body } = await get().expect(200);

      expect(unfold(body)).toContain('Stekker');
      expect(unfold(body)).not.toContain('ENTSOE Transparency Platform');
    });
  });

  describe('when no window can be given', () => {
    // A failed sync keeps the events a subscriber has. An empty calendar would delete them.
    test('no prices at all is a 503', async () => {
      start(BEFORE_PUBLICATION, () => {
        throw new Error('HTTP 503');
      });

      await get().expect(503);
    });

    test('only part of today is a 503', async () => {
      start(BEFORE_PUBLICATION, () => entsoeXml(['2026-11-02'], { '2026-11-02': 40 }));

      await get().expect(503);
    });
  });

  describe('validation', () => {
    test.each([
      'hours=0',
      'hours=25',
      'hours=1.5',
      'hours=abc',
      'hours=4&hours=5',
      'from=-1',
      'from=24',
      'from=7.5',
      'from=7&from=8',
      'to=0',
      'to=25',
      'to=abc',
      'from=10&to=10',
      'from=12&to=7',
      'from=10&to=13',
      'to=3',
      'interval=15M',
      'interval=bad',
      'vat=21'
    ])('rejects %s without calling upstream', async query => {
      start(BEFORE_PUBLICATION);

      await get(`?${query}`).expect(400);

      expect(entsoe).not.toHaveBeenCalled();
    });

    test('rejects an unknown country', async () => {
      await request(app).get('/api/xx/calendar.ics').expect(400);
    });

    test('accepts the widest settings', async () => {
      start(BEFORE_PUBLICATION);

      await get('?hours=24&from=0&to=24').expect(200);
    });
  });
});
