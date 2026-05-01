// tests/helpers.test.js - Unit tests for helper functions
const {
  parseMarkupOptions,
  parseIntervalOption,
  validateCountry,
  enrichPricesWithCountryInfo,
  buildCountryResponse,
  aggregateToHourly
} = require('../utils/helpers');

describe('Helper Functions', () => {
  describe('parseMarkupOptions', () => {
    test('should parse basic markup options', () => {
      const query = {
        markup: '0.024',
        variableMarkup: '5',
        vat: '0.21'
      };

      const result = parseMarkupOptions(query, 'nl');

      expect(result).toEqual({
        fixedMarkup: 0.024,
        variableMarkup: 5,
        vat: 0.21,
        includeVat: true,
        roundTo: 5
      });
    });

    test('should use autoVat for country default', () => {
      const query = { autoVat: 'true' };

      const result = parseMarkupOptions(query, 'nl');

      expect(result.vat).toBe(0.21); // Dutch VAT
      expect(result.includeVat).toBe(true);
    });

    test('should handle German VAT with autoVat', () => {
      const query = { autoVat: 'true' };

      const result = parseMarkupOptions(query, 'de');

      expect(result.vat).toBe(0.19); // German VAT
    });

    test('should default to zero values when no options provided', () => {
      const query = {};

      const result = parseMarkupOptions(query, 'nl');

      expect(result).toEqual({
        fixedMarkup: 0,
        variableMarkup: 0,
        vat: 0,
        includeVat: false,
        roundTo: 5
      });
    });
  });

  describe('validateCountry', () => {
    test('should validate supported country codes', () => {
      expect(validateCountry('nl')).toBe('nl');
      expect(validateCountry('NL')).toBe('nl');
      expect(validateCountry('de')).toBe('de');
      expect(validateCountry('DE')).toBe('de');
    });

    test('should return null for unsupported countries', () => {
      expect(validateCountry('xx')).toBe(null);
      expect(validateCountry('us')).toBe(null);
      expect(validateCountry('')).toBe(null);
      expect(validateCountry(null)).toBe(null);
      expect(validateCountry(undefined)).toBe(null);
    });
  });

  describe('enrichPricesWithCountryInfo', () => {
    const mockPrices = [
      {
        time: '2025-05-23T00:00:00.000Z',
        price: 0.12345,
        priceRaw: 123.45
      }
    ];

    test('should enrich prices with Dutch formatting', () => {
      const result = enrichPricesWithCountryInfo(mockPrices, 'nl');

      expect(result).toHaveLength(1);
      expect(result[0]).toHaveProperty('localTime');
      expect(result[0]).toHaveProperty('hour');
      expect(typeof result[0].localTime).toBe('string');
      expect(typeof result[0].hour).toBe('string');
    });

    test('should enrich prices with German formatting', () => {
      const result = enrichPricesWithCountryInfo(mockPrices, 'de');

      expect(result).toHaveLength(1);
      expect(result[0]).toHaveProperty('localTime');
      expect(result[0]).toHaveProperty('hour');
    });

    test('should include span info when requested', () => {
      const result = enrichPricesWithCountryInfo(mockPrices, 'nl', { includeSpanInfo: true });

      expect(result[0]).toHaveProperty('hourFromNow', 0);
      expect(result[0]).toHaveProperty('dayOfWeek');
    });
  });

  describe('buildCountryResponse', () => {
    const mockData = [{ price: 0.12345 }];
    const mockMarkup = { fixedMarkup: 0.024, vat: 0.21 };

    test('should build complete country response', () => {
      const result = buildCountryResponse('nl', mockData, mockMarkup, 'today');

      expect(result).toHaveProperty('status', 'success');
      expect(result).toHaveProperty('country');
      expect(result.country).toHaveProperty('code', 'NL');
      expect(result.country).toHaveProperty('name', 'Netherlands');
      expect(result.country).toHaveProperty('currency', 'EUR');
      expect(result.country).toHaveProperty('timezone', 'Europe/Amsterdam');
      expect(result).toHaveProperty('data', mockData);
      expect(result).toHaveProperty('markup', mockMarkup);
      expect(result).toHaveProperty('fetchedAt');
      expect(result).toHaveProperty('info');
      expect(result.info).toHaveProperty('type', 'today');
      expect(result.info).toHaveProperty('priceUnit', 'EUR/kWh');
    });

    test('should handle different countries correctly', () => {
      const result = buildCountryResponse('ch', mockData, mockMarkup, 'tomorrow');

      expect(result.country).toHaveProperty('code', 'CH');
      expect(result.country).toHaveProperty('name', 'Switzerland');
      expect(result.country).toHaveProperty('currency', 'EUR');
      expect(result.info).toHaveProperty('priceUnit', 'EUR/kWh');
    });

    test('should include additional info when provided', () => {
      const additionalInfo = { customField: 'customValue' };
      const result = buildCountryResponse('nl', mockData, mockMarkup, 'test', additionalInfo);

      expect(result.info).toHaveProperty('customField', 'customValue');
    });

    test('should set resolutionMinutes and totalIntervals/totalHours for 15M', () => {
      const data96 = Array.from({ length: 96 }, () => ({ price: 0.1 }));
      const result = buildCountryResponse('nl', data96, mockMarkup, 'today', { resolutionMinutes: 15 });
      expect(result.info.resolutionMinutes).toBe(15);
      expect(result.info.totalIntervals).toBe(96);
      expect(result.info.totalHours).toBe(24);
    });

    test('should default resolutionMinutes to 60 and equal totalHours/totalIntervals for hourly', () => {
      const data24 = Array.from({ length: 24 }, () => ({ price: 0.1 }));
      const result = buildCountryResponse('nl', data24, mockMarkup, 'today');
      expect(result.info.resolutionMinutes).toBe(60);
      expect(result.info.totalIntervals).toBe(24);
      expect(result.info.totalHours).toBe(24);
    });

    test('should attach warnings array when provided', () => {
      const result = buildCountryResponse('nl', [{ price: 0.1 }], mockMarkup, 'today', {
        warnings: ['fallback_source: stekker']
      });
      expect(result.warnings).toEqual(['fallback_source: stekker']);
    });

    test('should omit warnings field when none provided', () => {
      const result = buildCountryResponse('nl', [{ price: 0.1 }], mockMarkup, 'today');
      expect(result).not.toHaveProperty('warnings');
    });
  });

  describe('parseIntervalOption', () => {
    test('defaults to 60M when missing', () => {
      expect(parseIntervalOption({})).toBe('60M');
      expect(parseIntervalOption({ interval: '' })).toBe('60M');
    });

    test('accepts 60M and 15M (case-insensitive)', () => {
      expect(parseIntervalOption({ interval: '60M' })).toBe('60M');
      expect(parseIntervalOption({ interval: '15m' })).toBe('15M');
    });

    test('throws statusCode-400 error on invalid value', () => {
      try {
        parseIntervalOption({ interval: '5M' });
        throw new Error('should have thrown');
      } catch (err) {
        expect(err.statusCode).toBe(400);
        expect(err.message).toMatch(/interval/i);
      }
    });
  });

  describe('aggregateToHourly', () => {
    test('averages four quarters into one hourly bucket', () => {
      const quarters = [
        { time: '2025-05-23T10:00:00.000Z', priceMwh: 100 },
        { time: '2025-05-23T10:15:00.000Z', priceMwh: 120 },
        { time: '2025-05-23T10:30:00.000Z', priceMwh: 80 },
        { time: '2025-05-23T10:45:00.000Z', priceMwh: 100 }
      ];
      const result = aggregateToHourly(quarters);
      expect(result).toHaveLength(1);
      expect(result[0].time).toBe('2025-05-23T10:00:00.000Z');
      expect(result[0].priceMwh).toBe(100);
      expect(result[0].price).toBeCloseTo(0.1, 6);
    });

    test('passes through PT60M data unchanged (single point per hour)', () => {
      const hourly = [
        { time: '2025-05-23T10:00:00.000Z', priceMwh: 50 },
        { time: '2025-05-23T11:00:00.000Z', priceMwh: 75 }
      ];
      const result = aggregateToHourly(hourly);
      expect(result).toHaveLength(2);
      expect(result[0].priceMwh).toBe(50);
      expect(result[1].priceMwh).toBe(75);
    });

    test('handles partial-hour buckets (only 2 of 4 quarters present)', () => {
      const partial = [
        { time: '2025-05-23T10:00:00.000Z', priceMwh: 100 },
        { time: '2025-05-23T10:30:00.000Z', priceMwh: 200 }
      ];
      const result = aggregateToHourly(partial);
      expect(result).toHaveLength(1);
      expect(result[0].priceMwh).toBe(150);
    });

    test('groups across UTC hour boundaries correctly', () => {
      const cross = [
        { time: '2025-05-23T10:45:00.000Z', priceMwh: 100 },
        { time: '2025-05-23T11:00:00.000Z', priceMwh: 200 }
      ];
      const result = aggregateToHourly(cross);
      expect(result).toHaveLength(2);
      expect(result[0].time).toBe('2025-05-23T10:00:00.000Z');
      expect(result[1].time).toBe('2025-05-23T11:00:00.000Z');
    });

    test('returns empty array on empty input', () => {
      expect(aggregateToHourly([])).toEqual([]);
    });
  });
});
