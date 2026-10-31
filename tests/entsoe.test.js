const fs = require('fs');
const path = require('path');

const { EntsoeAPI } = require('../entsoe');
const { aggregateToHourly } = require('../utils/helpers');

const api = new EntsoeAPI('test-key');

function point(position, amount) {
  return `<Point><position>${position}</position><price.amount>${amount}</price.amount></Point>`;
}

function series({ sequence, resolution = 'PT15M', start, end, points }) {
  const tag = 'classificationSequence_AttributeInstanceComponent.position';
  const classification = sequence ? `<${tag}>${sequence}</${tag}>` : '';
  return `<TimeSeries>${classification}<curveType>A03</curveType><Period>
    <timeInterval><start>${start}</start><end>${end}</end></timeInterval>
    <resolution>${resolution}</resolution>${points.join('')}
  </Period></TimeSeries>`;
}

function document(...timeSeries) {
  return `<?xml version="1.0"?><Publication_MarketDocument>${timeSeries.join('')}</Publication_MarketDocument>`;
}

const HOUR = { start: '2026-10-30T10:00Z', end: '2026-10-30T11:00Z' };

describe('EntsoeAPI.parseResponse', () => {
  describe('real response with two series and an omitted point (AT, 2026-10-31)', () => {
    // Expected values are from the energy-charts.info API, not from ENTSOE or this code.
    const xml = fs.readFileSync(path.join(__dirname, 'fixtures', 'entsoe-at-two-series.xml'), 'utf8');
    const prices = api.parseResponse(xml);
    const at = time => prices.find(p => p.time === time);

    test('returns all 96 quarters even though the document has only 95 points', () => {
      expect(prices).toHaveLength(96);
    });

    test('uses the published day-ahead series rather than the other series', () => {
      expect(at('2026-10-30T23:00:00.000Z').priceMwh).toBe(254.82);
      expect(at('2026-10-30T23:15:00.000Z').priceMwh).toBe(246.73);
      expect(at('2026-10-31T22:45:00.000Z').priceMwh).toBe(232.26);
    });

    test('fills the omitted point with the previous price', () => {
      expect(at('2026-10-31T18:15:00.000Z').priceMwh).toBe(301.36);
    });

    test('produces the correct hourly mean for the hour with the omitted point', () => {
      const hour = aggregateToHourly(prices).find(p => p.time === '2026-10-31T18:00:00.000Z');

      expect(hour.priceMwh).toBeCloseTo(299.645, 5);
    });
  });

  describe('omitted points', () => {
    test('repeats a price across omitted points in the middle of a period', () => {
      const xml = document(series({ ...HOUR, points: [point(1, 10), point(4, 40)] }));

      expect(api.parseResponse(xml).map(p => p.priceMwh)).toEqual([10, 10, 10, 40]);
    });

    test('repeats the last price through to the end of the period', () => {
      const xml = document(series({ ...HOUR, points: [point(1, 10), point(2, 20)] }));

      expect(api.parseResponse(xml).map(p => p.priceMwh)).toEqual([10, 20, 20, 20]);
    });

    test('returns one point per interval at the correct times', () => {
      const xml = document(series({ ...HOUR, points: [point(1, 10)] }));

      expect(api.parseResponse(xml).map(p => p.time)).toEqual([
        '2026-10-30T10:00:00.000Z',
        '2026-10-30T10:15:00.000Z',
        '2026-10-30T10:30:00.000Z',
        '2026-10-30T10:45:00.000Z'
      ]);
    });

    test('keeps a price of zero and repeats it', () => {
      const xml = document(series({ ...HOUR, points: [point(1, 5), point(2, 0)] }));

      expect(api.parseResponse(xml).map(p => p.priceMwh)).toEqual([5, 0, 0, 0]);
    });

    test('keeps negative prices', () => {
      const xml = document(series({ ...HOUR, points: [point(1, -3.5)] }));

      expect(api.parseResponse(xml).map(p => p.price)).toEqual([-0.0035, -0.0035, -0.0035, -0.0035]);
    });

    test('does not fill past the requested window', () => {
      const xml = document(series({ ...HOUR, points: [point(1, 10)] }));

      const prices = api.parseResponse(xml, new Date('2026-10-30T10:15Z'), new Date('2026-10-30T10:45Z'));

      expect(prices.map(p => p.time)).toEqual(['2026-10-30T10:15:00.000Z', '2026-10-30T10:30:00.000Z']);
    });

    test('fills hourly periods using their own resolution', () => {
      const xml = document(
        series({
          resolution: 'PT60M',
          start: '2026-10-30T10:00Z',
          end: '2026-10-30T13:00Z',
          points: [point(1, 10), point(3, 30)]
        })
      );

      expect(api.parseResponse(xml).map(p => [p.time, p.priceMwh])).toEqual([
        ['2026-10-30T10:00:00.000Z', 10],
        ['2026-10-30T11:00:00.000Z', 10],
        ['2026-10-30T12:00:00.000Z', 30]
      ]);
    });
  });

  describe('series selection', () => {
    test.each([
      ['first', [2, 1]],
      ['last', [1, 2]]
    ])('uses sequence 1 when it comes %s in the document', (_, order) => {
      const amounts = { 1: 100, 2: 999 };
      const xml = document(...order.map(s => series({ ...HOUR, sequence: s, points: [point(1, amounts[s])] })));

      expect(api.parseResponse(xml).map(p => p.priceMwh)).toEqual([100, 100, 100, 100]);
    });

    test('uses a series without a sequence and ignores sequence 2 (DK)', () => {
      const xml = document(
        series({ ...HOUR, points: [point(1, 100)] }),
        series({ ...HOUR, sequence: 2, points: [point(1, 999)] })
      );

      expect(api.parseResponse(xml).map(p => p.priceMwh)).toEqual([100, 100, 100, 100]);
    });

    test('returns nothing for a period that only has sequence 2', () => {
      const xml = document(series({ ...HOUR, sequence: 2, points: [point(1, 999)] }));

      expect(api.parseResponse(xml)).toEqual([]);
    });
  });
});
