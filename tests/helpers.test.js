// tests/helpers.test.js - Unit tests for helper functions
const {
  parseMarkupOptions,
  validateCountry,
  enrichPricesWithCountryInfo,
  buildCountryResponse
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
      expect(result.country).toHaveProperty('currency', 'CHF');
      expect(result.info).toHaveProperty('priceUnit', 'CHF/kWh');
    });

    test('should include additional info when provided', () => {
      const additionalInfo = { customField: 'customValue' };
      const result = buildCountryResponse('nl', mockData, mockMarkup, 'test', additionalInfo);

      expect(result.info).toHaveProperty('customField', 'customValue');
    });
  });
});
