const fs = require('fs');
const path = require('path');
const { loadSettings, renderPollingUrl, renderLayout } = require('./trmnl/harness');

const SETTINGS_PATH = 'integrations/trmnl-70055-energy_day_ahead_prices/settings.yml';
const OLD_URL =
  'https://dap.xadi.eu/api/{{ country }}/{{ timeframe }}?interval={{ resolution }}&markup={{ markup }}&vat={{ vat }}';

const settings = loadSettings();
const field = key => settings.custom_fields.find(f => f.keyname === key);
const optionValues = key =>
  field(key).options.map(option => {
    if (typeof option === 'object' && option !== null) {
      return String(Object.values(option)[0]);
    }
    return String(option);
  });

// Five hourly points shaped like the API's /today response
const fixtureResponse = {
  data: [
    { time: '2026-11-01T00:00:00.000Z', price: 0.1, hour: '01:00', localTime: 'zo 1 nov, 01:00' },
    { time: '2026-11-01T01:00:00.000Z', price: 0.08, hour: '02:00', localTime: 'zo 1 nov, 02:00' },
    { time: '2026-11-01T02:00:00.000Z', price: 0.06, hour: '03:00', localTime: 'zo 1 nov, 03:00' },
    { time: '2026-11-01T03:00:00.000Z', price: 0.07, hour: '04:00', localTime: 'zo 1 nov, 04:00' },
    { time: '2026-11-01T04:00:00.000Z', price: 0.09, hour: '05:00', localTime: 'zo 1 nov, 05:00' }
  ]
};

test('the polling URL is unchanged', () => expect(loadSettings().polling_url).toBe(OLD_URL));

test('adds the new fields as optional', () => {
  for (const key of ['variable_markup', 'round_to', 'best_period_hours', 'language']) {
    expect(field(key).optional).toBe(true);
  }
});

test('vat is optional with no default', () => {
  expect(field('vat').optional).toBe(true);
  expect(field('vat')).not.toHaveProperty('default');
});

test('round_to has no default', () => {
  expect(field('round_to')).not.toHaveProperty('default');
});

test('new select option values are quoted in the raw text', () => {
  const lines = fs.readFileSync(path.join(__dirname, '..', SETTINGS_PATH), 'utf8').split('\n');
  for (const key of ['round_to', 'best_period_hours', 'language']) {
    const start = lines.findIndex(line => line === `- keyname: ${key}`);
    const optionsAt = lines.indexOf('  options:', start);
    const values = [];
    for (let i = optionsAt + 1; lines[i].startsWith('  - '); i++) {
      values.push(lines[i].slice(lines[i].lastIndexOf(': ') + 2));
    }
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(value).toMatch(/^'[^']+'$/);
    }
  }
});

test('existing options stay', () => {
  expect(optionValues('country')).toEqual(['DE', 'NL']);
  expect(optionValues('timeframe')).toEqual(['next24h', 'today']);
  expect(optionValues('resolution')).toEqual(['15M', '60M']);
});

test('language options', () => {
  expect(optionValues('language')).toEqual(['device', 'en', 'nl', 'de', 'fr', 'da', 'nb', 'sv']);
});

test('numeric selects use labelled, quoted values', () => {
  expect(optionValues('round_to')).toEqual(['2', '3', '4', '5']);
  expect(optionValues('best_period_hours')).toEqual(['1', '2', '3', '4', '6', '8']);
});

test('the harness can run the current layouts', async () => {
  const { chart, errors } = await renderLayout('full', {
    response: fixtureResponse,
    fieldValues: {},
    user: { locale: 'nl' }
  });
  expect(errors).toEqual([]);
  expect(chart.series[0].data).toHaveLength(fixtureResponse.data.length);
});

test('an install with no vat still renders vat= in this update', async () => {
  await expect(
    renderPollingUrl({ country: 'nl', timeframe: 'next24h', resolution: '60m', markup: 0 })
  ).resolves.toBe('https://dap.xadi.eu/api/nl/next24h?interval=60m&markup=0&vat=');
});
