const express = require('express');
const request = require('supertest');

const app = require('../index');
const { createRateLimiter, parseRateLimit } = require('../middleware/rateLimit');

function appWithLimiter(options) {
  const limited = express();
  limited.use(createRateLimiter(options));
  limited.get('/', (req, res) => res.json({ ok: true }));
  return limited;
}

describe('Rate limiter', () => {
  describe('client identification behind nginx', () => {
    // nginx appends the address it saw, so only the rightmost X-Forwarded-For entry is trustworthy.
    test('changing the client-supplied X-Forwarded-For entries does not give a new allowance', async () => {
      const first = await request(app).get('/api/countries').set('X-Forwarded-For', '198.51.100.1, 203.0.113.10');
      const second = await request(app).get('/api/countries').set('X-Forwarded-For', '198.51.100.2, 203.0.113.10');

      expect(Number(second.headers['x-ratelimit-remaining'])).toBe(Number(first.headers['x-ratelimit-remaining']) - 1);
    });

    test('clients with different addresses have separate allowances', async () => {
      await request(app).get('/api/countries').set('X-Forwarded-For', '203.0.113.20');
      const other = await request(app).get('/api/countries').set('X-Forwarded-For', '203.0.113.21');

      const limit = Number(other.headers['x-ratelimit-limit']);
      expect(Number(other.headers['x-ratelimit-remaining'])).toBe(limit - 1);
    });
  });

  test.each([
    ['127.0.0.1', true],
    ['::1', true],
    ['::ffff:127.0.0.1', true],
    ['203.0.113.50', false],
    ['::ffff:203.0.113.50', false]
  ])('a connection from %s is trusted to set X-Forwarded-For: %s', (address, trusted) => {
    expect(app.get('trust proxy fn')(address, 0)).toBe(trusted);
  });

  test('a provider request counts once against the allowance', async () => {
    const response = await request(app).get('/api/providers').set('X-Forwarded-For', '203.0.113.30');

    const limit = Number(response.headers['x-ratelimit-limit']);
    expect(Number(response.headers['x-ratelimit-remaining'])).toBe(limit - 1);
  });

  describe('enforcement', () => {
    let now;

    beforeEach(() => {
      now = 1_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    test('allows requests up to the limit and rejects the next one with 429', async () => {
      const limited = appWithLimiter({ limit: 2 });

      await request(limited).get('/').expect(200);
      const last = await request(limited).get('/').expect(200);
      const rejected = await request(limited).get('/').expect(429);

      expect(last.headers['x-ratelimit-remaining']).toBe('0');
      expect(rejected.headers['retry-after']).toBe('1');
      expect(rejected.body).toMatchObject({ status: 'error', limitPerSecond: 2 });
    });

    test('allows requests again once the window has passed', async () => {
      const limited = appWithLimiter({ limit: 1 });

      await request(limited).get('/').expect(200);
      await request(limited).get('/').expect(429);
      now += 1000;
      await request(limited).get('/').expect(200);
    });

    test('removes buckets of clients whose window has passed', async () => {
      const buckets = new Map();
      const limited = express();
      limited.set('trust proxy', 1);
      limited.use(createRateLimiter({ limit: 5, buckets }));
      limited.get('/', (req, res) => res.json({ ok: true }));

      await request(limited).get('/').set('X-Forwarded-For', '203.0.113.40');
      await request(limited).get('/').set('X-Forwarded-For', '203.0.113.41');
      expect(buckets.size).toBe(2);

      now += 1000;
      await request(limited).get('/').set('X-Forwarded-For', '203.0.113.42');

      expect([...buckets.keys()]).toEqual(['203.0.113.42']);
    });
  });

  describe('parseRateLimit', () => {
    test.each([
      ['25', 25],
      ['1', 1]
    ])('accepts %s', (raw, expected) => {
      expect(parseRateLimit(raw)).toBe(expected);
    });

    test.each([undefined, '', 'abc', '10abc', '0', '-5', '1.5'])('falls back to 10 for %s', raw => {
      expect(parseRateLimit(raw)).toBe(10);
    });
  });
});
