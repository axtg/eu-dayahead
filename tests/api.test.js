const request = require('supertest');
const app = require('../index');

describe('European Energy Prices API', () => {
  let app;

  beforeAll(() => {
    // Import app fresh for each test run
    app = require('../index');
  });

  afterAll(async () => {
    // Close any open handles
    if (app && app.close) {
      await app.close();
    }
    // Give a small delay for cleanup
    await new Promise(resolve => setTimeout(resolve, 500));
  });

  describe('Health & System Endpoints', () => {
    test('GET /health should return healthy status', async () => {
      const response = await request(app).get('/health').expect(200);

      expect(response.body).toHaveProperty('status', 'healthy');
      expect(response.body).toHaveProperty('timestamp');
      expect(response.body).toHaveProperty('supportedCountries');
    });

    test('GET /api/countries should return supported countries', async () => {
      const response = await request(app).get('/api/countries').expect(200);

      expect(response.body).toHaveProperty('status', 'success');
      expect(response.body).toHaveProperty('data');
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBeGreaterThan(0);

      // Check structure of first country
      const firstCountry = response.body.data[0];
      expect(firstCountry).toHaveProperty('code');
      expect(firstCountry).toHaveProperty('name');
      expect(firstCountry).toHaveProperty('currency');
      expect(firstCountry).toHaveProperty('timezone');
      expect(firstCountry).toHaveProperty('defaultVat');
    });
  });

  describe('Country-Specific Endpoints', () => {
    test('GET /api/nl/today should return Dutch energy prices', async () => {
      const response = await request(app).get('/api/nl/today').expect(200);

      expect(response.body).toHaveProperty('status', 'success');
      expect(response.body).toHaveProperty('country');
      expect(response.body.country).toHaveProperty('code', 'NL');
      expect(response.body).toHaveProperty('data');
      expect(Array.isArray(response.body.data)).toBe(true);

      // Check price data structure
      if (response.body.data.length > 0) {
        const firstPrice = response.body.data[0];
        expect(firstPrice).toHaveProperty('time');
        expect(firstPrice).toHaveProperty('price');
        expect(firstPrice).toHaveProperty('priceMwh'); // Fixed: changed from priceRaw to priceMwh
        expect(typeof firstPrice.price).toBe('number');
      }
    }, 15000); // Extended timeout for API calls

    test('GET /api/xx/today should return 400 for unsupported country', async () => {
      const response = await request(app).get('/api/xx/today').expect(400);

      expect(response.body).toHaveProperty('status', 'error');
      expect(response.body.message).toContain('Unsupported country');
    });
  });

  describe('Query Parameters', () => {
    test('GET /api/nl/today with markup parameters should apply markup', async () => {
      const response = await request(app)
        .get('/api/nl/today')
        .query({
          markup: '0.024',
          vat: '0.21'
        })
        .expect(200);

      expect(response.body.markup).toHaveProperty('fixedMarkup', 0.024);
      expect(response.body.markup).toHaveProperty('vat', 0.21);

      // Check that markup is applied
      if (response.body.data.length > 0) {
        const firstPrice = response.body.data[0];
        expect(firstPrice).toHaveProperty('markup');
        expect(firstPrice.markup).toHaveProperty('fixed', 0.024);
        expect(firstPrice.markup).toHaveProperty('vat', 0.21);
      }
    }, 15000);

    test('GET /api/nl/today with autoVat should use default VAT', async () => {
      const response = await request(app).get('/api/nl/today').query({ autoVat: 'true' }).expect(200);

      expect(response.body.markup).toHaveProperty('vat', 0.21); // Dutch VAT
    }, 15000);
  });

  describe('Provider Endpoints', () => {
    test('GET /api/providers should return available providers', async () => {
      const response = await request(app).get('/api/providers').expect(200);

      expect(response.body).toHaveProperty('status', 'success');
      expect(response.body).toHaveProperty('data');
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBeGreaterThan(0);
    });

    test('GET /api/providers/next-energy should return Next Energy pricing', async () => {
      const response = await request(app).get('/api/providers/next-energy').expect(200);

      expect(response.body).toHaveProperty('status', 'success');
      expect(response.body).toHaveProperty('provider', 'Next Energy');
      expect(response.body).toHaveProperty('data');
      expect(Array.isArray(response.body.data)).toBe(true);
    }, 15000);
  });

  describe('Documentation Endpoints', () => {
    test('GET /docs/openapi.yaml should return OpenAPI spec', async () => {
      const response = await request(app).get('/docs/openapi.yaml').expect(200);

      expect(response.headers['content-type']).toMatch(/yaml|text/);
    });

    test('GET /docs should return HTML documentation', async () => {
      const response = await request(app).get('/docs/').expect(200);

      expect(response.headers['content-type']).toMatch(/html/);
      expect(response.text).toContain('European Energy Prices API');
    });
  });

  describe('Error Handling', () => {
    test('GET /nonexistent-endpoint should return 404', async () => {
      const response = await request(app).get('/nonexistent-endpoint').expect(404);

      expect(response.body).toHaveProperty('status', 'error');
      expect(response.body.message).toContain('Endpoint not found');
    });
  });

  describe('Regression Tests - Timezone and Hour Count Bugs', () => {
    describe('Today Endpoint - Hour Count Bug', () => {
      test('GET /api/nl/today should return exactly 24 hours', async () => {
        const response = await request(app).get('/api/nl/today').expect(200);

        expect(response.body).toHaveProperty('status', 'success');
        expect(response.body).toHaveProperty('data');
        expect(Array.isArray(response.body.data)).toBe(true);

        // Critical: Should return exactly 24 hours, not 46+ hours
        expect(response.body.data.length).toBe(24);
        expect(response.body.info.totalHours).toBe(24);
      }, 15000);

      test('GET /api/de/today should return exactly 24 hours for Germany', async () => {
        const response = await request(app).get('/api/de/today').expect(200);

        expect(response.body.data.length).toBe(24);
        expect(response.body.info.totalHours).toBe(24);
      }, 15000);

      test('Today endpoint should return all 24 hours exactly once (timezone-agnostic)', async () => {
        const response = await request(app).get('/api/nl/today').expect(200);

        expect(response.body.data.length).toBe(24);

        // Check that we have all hours from 00:00 to 23:00
        const hours = response.body.data.map(entry => entry.hour);
        const expectedHours = Array.from({ length: 24 }, (_, i) =>
          `${i.toString().padStart(2, '0')}:00`
        );

        // Sort both arrays to handle potential timezone-related ordering issues
        const sortedHours = [...hours].sort();
        const sortedExpected = [...expectedHours].sort();

        expect(sortedHours).toEqual(sortedExpected);

        // Verify we have exactly one of each hour (no duplicates)
        const hourCounts = {};
        hours.forEach(hour => {
          hourCounts[hour] = (hourCounts[hour] || 0) + 1;
        });

        // Each hour should appear exactly once
        Object.values(hourCounts).forEach(count => {
          expect(count).toBe(1);
        });

        // Verify all expected hours are present
        expectedHours.forEach(expectedHour => {
          expect(hours).toContain(expectedHour);
        });
      }, 15000);
    });

    describe('Next24h Endpoint - Timezone Bug', () => {
      test('GET /api/nl/next24h should start from current hour with correct timezone', async () => {
        const response = await request(app).get('/api/nl/next24h').expect(200);

        expect(response.body).toHaveProperty('status', 'success');
        expect(response.body).toHaveProperty('data');
        expect(Array.isArray(response.body.data)).toBe(true);

        // Should have at least some hours (may be less than 24 due to data availability)
        expect(response.body.data.length).toBeGreaterThan(0);

        // First entry should be the current hour with hourFromNow: 0
        const firstEntry = response.body.data[0];
        expect(firstEntry).toHaveProperty('hourFromNow', 0);
      }, 15000);

      test('Next24h should start with hourFromNow: 0 for current hour', async () => {
        const response = await request(app).get('/api/nl/next24h').expect(200);

        expect(response.body.data.length).toBeGreaterThan(0);

        // First entry should be the current hour with hourFromNow: 0
        const firstEntry = response.body.data[0];
        expect(firstEntry).toHaveProperty('hourFromNow', 0);

        // Check that hourFromNow increments correctly for available hours
        for (let i = 0; i < Math.min(5, response.body.data.length); i++) {
          expect(response.body.data[i].hourFromNow).toBe(i);
        }
      }, 15000);

      test('Next24h should work correctly across different timezones', async () => {
        // Test multiple countries with different timezones
        const countries = ['nl', 'de', 'ch']; // Netherlands (CEST), Germany (CEST), Switzerland (CEST)

        for (const country of countries) {
          const response = await request(app).get(`/api/${country}/next24h`).expect(200);

          expect(response.body.data.length).toBeGreaterThan(0);
          expect(response.body.data[0].hourFromNow).toBe(0);
        }
      }, 30000);
    });

    describe('Next/N Hours Endpoint - Timezone Bug', () => {
      test('GET /api/nl/next/3 should return exactly 3 hours starting from current hour', async () => {
        const response = await request(app).get('/api/nl/next/3').expect(200);

        expect(response.body).toHaveProperty('status', 'success');
        expect(response.body.data.length).toBe(3);
        expect(response.body.info.totalHours).toBe(3);
        expect(response.body.info.requestedHours).toBe(3);
        expect(response.body.info.actualHours).toBe(3);

        // Should start with hourFromNow: 0
        expect(response.body.data[0].hourFromNow).toBe(0);
        expect(response.body.data[1].hourFromNow).toBe(1);
        expect(response.body.data[2].hourFromNow).toBe(2);
      }, 15000);

      test('GET /api/nl/next/1 should return exactly 1 hour (current hour)', async () => {
        const response = await request(app).get('/api/nl/next/1').expect(200);

        expect(response.body.data.length).toBe(1);
        expect(response.body.data[0].hourFromNow).toBe(0);
      }, 15000);
    });

    describe('Timezone Consistency', () => {
      test('All endpoints should use target country timezone, not server timezone', async () => {
        const todayResponse = await request(app).get('/api/nl/today').expect(200);
        const next24hResponse = await request(app).get('/api/nl/next24h').expect(200);

        // Both should use Netherlands timezone
        expect(todayResponse.body.country.timezone).toBe('Europe/Amsterdam');
        expect(next24hResponse.body.country.timezone).toBe('Europe/Amsterdam');

        // Time calculations should be consistent with the target timezone
        expect(todayResponse.body.info.timezone).toBe('Europe/Amsterdam');
        expect(next24hResponse.body.info.timezone).toBe('Europe/Amsterdam');
      }, 15000);

      test('Different countries should use their respective timezones', async () => {
        const nlResponse = await request(app).get('/api/nl/today').expect(200);
        const chResponse = await request(app).get('/api/ch/today').expect(200);

        expect(nlResponse.body.country.timezone).toBe('Europe/Amsterdam');
        expect(chResponse.body.country.timezone).toBe('Europe/Zurich');
      }, 15000);
    });
  });
});

// Helper function to test if server starts correctly
describe('Server Startup', () => {
  test('should start without errors', done => {
    const server = app.listen(0, err => {
      if (err) {
        done(err);
      } else {
        server.close(done);
      }
    });
  });
});
