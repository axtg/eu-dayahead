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

    test('GET /api/de/tomorrow should return German energy prices', async () => {
      const response = await request(app).get('/api/de/tomorrow').expect(200);

      expect(response.body).toHaveProperty('status', 'success');
      expect(response.body).toHaveProperty('country');
      expect(response.body.country).toHaveProperty('code', 'DE');
      expect(response.body.country).toHaveProperty('currency', 'EUR');
    }, 15000);

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
    test('GET /api-docs/openapi.yaml should return OpenAPI spec', async () => {
      const response = await request(app).get('/api-docs/openapi.yaml').expect(200);

      expect(response.headers['content-type']).toMatch(/yaml|text/);
    });

    test('GET /api-docs should return HTML documentation', async () => {
      const response = await request(app).get('/api-docs/').expect(200);

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
