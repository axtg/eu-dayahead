const { StekkerAPI } = require('../stekker');

function stekkerHtml(x, y) {
  const json = JSON.stringify([{ name: 'Market price', x, y }]).replace(/"/g, '&quot;');
  return `<div data-epex-forecast-graph-data-value="${json}">price</div>`;
}

describe('StekkerAPI.parseResponse', () => {
  const times = ['2026-10-30T10:00:00+01:00', '2026-10-30T11:00:00+01:00', '2026-10-30T12:00:00+01:00'];

  test('keeps a price of zero', () => {
    const prices = new StekkerAPI().parseResponse(stekkerHtml(times, [10, 0, -3]), null, null, true);

    expect(prices.map(p => p.priceMwh)).toEqual([10, 0, -3]);
    expect(prices[1].price).toBe(0);
  });

  test('drops missing prices', () => {
    const prices = new StekkerAPI().parseResponse(stekkerHtml(times, [10, null, -3]), null, null, true);

    expect(prices.map(p => p.priceMwh)).toEqual([10, -3]);
  });
});

describe('fetchCountryPrices resolution', () => {
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

  function entsoeDay(resolution, count) {
    const points = Array.from(
      { length: count },
      (_, i) => `<Point><position>${i + 1}</position><price.amount>${i + 1}</price.amount></Point>`
    );
    return `<Publication_MarketDocument><TimeSeries><Period>
      <timeInterval><start>${today}T00:00Z</start><end>${tomorrow}T00:00Z</end></timeInterval>
      <resolution>${resolution}</resolution>${points.join('')}
    </Period></TimeSeries></Publication_MarketDocument>`;
  }

  async function fetchWith(xml, interval) {
    const originalKey = process.env.ENTSOE_API_KEY;
    process.env.ENTSOE_API_KEY = 'test-key';

    try {
      let helpers;
      jest.isolateModules(() => {
        const { EntsoeAPI } = require('../entsoe');
        EntsoeAPI.prototype.makeRequest = async () => xml;
        helpers = require('../utils/helpers');
      });
      return await helpers.fetchCountryPrices('ch', {}, { interval });
    } finally {
      if (originalKey === undefined) delete process.env.ENTSOE_API_KEY;
      else process.env.ENTSOE_API_KEY = originalKey;
    }
  }

  test.each([
    ['PT60M', 24, '15M', 60],
    ['PT60M', 24, '60M', 60],
    ['PT15M', 96, '15M', 15],
    ['PT15M', 96, '60M', 60]
  ])('%s upstream data (%i points) requested as %s reports %i minutes', async (res, count, interval, expected) => {
    const result = await fetchWith(entsoeDay(res, count), interval);

    expect(result.resolutionMinutes).toBe(expected);
  });

  test('hourly data requested as 15M still counts as 24 hours', async () => {
    const { buildCountryResponse } = require('../utils/helpers');
    const result = await fetchWith(entsoeDay('PT60M', 24), '15M');

    const response = buildCountryResponse('ch', result.prices, {}, 'today', {
      resolutionMinutes: result.resolutionMinutes
    });

    expect(response.info.totalIntervals).toBe(24);
    expect(response.info.totalHours).toBe(24);
  });
});
