const request = require('supertest');

const app = require('../index');
const { COUNTRIES } = require('../config/countries');
const { StekkerAPI } = require('../stekker');
const { parseMarkupOptions } = require('../utils/helpers');

const ROUTES = ['/api/nl/today', '/api/nl/next24h', '/api/nl/next/6'];

const INVALID_QUERIES = [
  'vat=21',
  'vat=-0.1',
  'vat=abc',
  'vat=0,21',
  'vat=0.21&vat=0.09',
  'vat[a]=1',
  'markup=Infinity',
  'markup=1e308',
  'markup=24',
  'markup=0x10',
  'fixedMarkup=abc',
  'variableMarkup=NaN',
  'variableMarkup=100000',
  'roundTo=400',
  'roundTo=-1',
  'roundTo=2.5',
  'autoVat=yes',
  'includeVat=1'
];

describe('query parameter validation', () => {
  describe.each(ROUTES)('%s', route => {
    test.each(INVALID_QUERIES)('rejects %s', async query => {
      const response = await request(app).get(`${route}?${query}`).expect(400);

      expect(response.body.status).toBe('error');
    });
  });

  test('a very long number is rejected quickly', () => {
    const started = Date.now();

    expect(() => parseMarkupOptions({ markup: `${'1'.repeat(16000)}x` }, 'nl')).toThrow('Invalid markup');
    expect(Date.now() - started).toBeLessThan(50);
  });

  test('explains that VAT is a decimal', async () => {
    const response = await request(app).get('/api/nl/today?vat=21').expect(400);

    expect(response.body.message).toContain('0.21');
  });
});

describe('/next/:hours validation', () => {
  test.each(['24.png', '3abc', '1.5', '0', '49', '-1'])('rejects %s', async hours => {
    await request(app).get(`/api/nl/next/${hours}`).expect(400);
  });
});

describe('parseMarkupOptions', () => {
  // Query strings real clients send, from the production logs.
  test.each([
    ['interval=60M&markup=0&vat=0&roundTo=5', { fixedMarkup: 0, vat: 0, includeVat: false, roundTo: 5 }],
    ['markup=0.00&vat=0.06', { fixedMarkup: 0, vat: 0.06, includeVat: true }],
    ['interval=60m&markup=0.12&vat=0', { fixedMarkup: 0.12, vat: 0 }],
    ['vat=0.21&markup=0.1115702479338843&roundTo=4', { fixedMarkup: 0.1115702479338843, vat: 0.21, roundTo: 4 }],
    ['markup=0&variableMarkup=0&vat=0.21&autoVat=true&roundTo=5', { vat: 0.21, variableMarkup: 0 }],
    ['interval=15M&autoVat=false', { vat: 0, includeVat: false }]
  ])('accepts %s', (queryString, expected) => {
    const query = Object.fromEntries(new URLSearchParams(queryString));

    expect(parseMarkupOptions(query, 'nl')).toMatchObject(expected);
  });

  test('treats an empty value as not given', () => {
    expect(parseMarkupOptions({ vat: '', markup: '', roundTo: '' }, 'nl')).toEqual({
      fixedMarkup: 0,
      variableMarkup: 0,
      vat: 0,
      includeVat: false,
      roundTo: 5
    });
  });

  test('honours roundTo=0', () => {
    expect(parseMarkupOptions({ roundTo: '0' }, 'nl').roundTo).toBe(0);
  });

  test('allows a negative markup, for discounts', () => {
    expect(parseMarkupOptions({ markup: '-0.01' }, 'nl').fixedMarkup).toBe(-0.01);
  });

  test('accepts fixedMarkup as an alias of markup', () => {
    expect(parseMarkupOptions({ fixedMarkup: '0.03' }, 'nl').fixedMarkup).toBe(0.03);
  });

  test('includeVat=true uses the country rate, not 21%', () => {
    expect(parseMarkupOptions({ includeVat: 'true' }, 'de')).toMatchObject({ vat: 0.19, includeVat: true });
  });

  test('vat=auto uses the country rate', () => {
    expect(parseMarkupOptions({ vat: 'auto' }, 'de')).toMatchObject({ vat: 0.19, includeVat: true });
  });

  test('an explicit vat wins over autoVat and includeVat, including 0', () => {
    expect(parseMarkupOptions({ vat: '0.09', autoVat: 'true' }, 'de').vat).toBe(0.09);
    expect(parseMarkupOptions({ vat: '0', autoVat: 'true' }, 'de')).toMatchObject({ vat: 0, includeVat: false });
    expect(parseMarkupOptions({ vat: '0', includeVat: 'true' }, 'de')).toMatchObject({ vat: 0, includeVat: false });
  });
});

describe('default VAT rates', () => {
  test('Switzerland uses the 8.1% standard rate', () => {
    expect(COUNTRIES.ch.defaultVat).toBe(0.081);
  });

  test('Belgium uses the 6% household electricity rate', () => {
    expect(COUNTRIES.be.defaultVat).toBe(0.06);
  });

  test('each price shows the VAT percentage without rounding it away', () => {
    const [price] = new StekkerAPI().applyMarkup(
      [{ time: 'x', price: 0.1 }],
      parseMarkupOptions({ autoVat: 'true' }, 'ch')
    );

    expect(price.markup.vatPercent).toBe('8.1%');
  });

  test('/api/countries shows a clean VAT percentage', async () => {
    const response = await request(app).get('/api/countries').expect(200);
    const swiss = response.body.data.find(country => country.code === 'CH');

    expect(swiss.vatPercent).toBe('8.1%');
  });
});
