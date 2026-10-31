const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const express = require('express');
const request = require('supertest');

const { loggingMiddleware, logError, getClientId } = require('../middleware/logging');

const SERVER_SCRIPT =
  "require('./index').listen(0, '127.0.0.1', function () { console.log('PORT=' + this.address().port); });";

// Runs in a real process: the bug under test killed the process via an uncaught exception,
// which would take the Jest worker down with it if the app ran in-process.
function startServer() {
  const child = spawn(process.execPath, ['-e', SERVER_SCRIPT], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, LOGTAIL_TOKEN: '', NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'ignore']
  });

  return new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/PORT=(\d+)/);
      if (match) resolve({ child, port: Number(match[1]) });
    });
    child.on('exit', code => reject(new Error(`Server exited during startup (code ${code})`)));
  });
}

// http.get rather than supertest so the malformed path reaches the server byte-for-byte.
function getStatus(port, urlPath) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: urlPath, agent: false }, res => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      })
      .on('error', reject);
  });
}

describe('Logging middleware', () => {
  describe('paths with undecodable percent sequences', () => {
    let server;

    beforeEach(async () => {
      server = await startServer();
    });

    afterEach(() => {
      server.child.kill();
    });

    test.each(['/%FF', '/api/%FF/today', '/nonexistent/%FF'])(
      '%s returns 400 and the server keeps running',
      async url => {
        expect(await getStatus(server.port, url)).toBe(400);
        expect(await getStatus(server.port, '/health')).toBe(200);
      }
    );
  });

  test('a request with an undecodable path is still logged', async () => {
    const originalFetch = global.fetch;
    const originalToken = process.env.LOGTAIL_TOKEN;
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
    process.env.LOGTAIL_TOKEN = 'test-token';

    try {
      let app;
      jest.isolateModules(() => {
        const { loggingMiddleware: middleware } = require('../middleware/logging');
        app = express();
        app.use(middleware);
        app.get('/:country/today', (req, res) => res.json({ ok: true }));
      });

      await request(app).get('/%FF/today');

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const entry = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(entry).toMatchObject({ statusCode: 400, url: '/%FF/today', country: null });
    } finally {
      global.fetch = originalFetch;
      process.env.LOGTAIL_TOKEN = originalToken;
    }
  });

  test('no part of the token is written to the console at startup', () => {
    const originalToken = process.env.LOGTAIL_TOKEN;
    process.env.LOGTAIL_TOKEN = 'SECRETTOKENVALUE';
    console.log.mockClear();

    try {
      jest.isolateModules(() => require('../middleware/logging'));

      expect(console.log).toHaveBeenCalled();
      expect(JSON.stringify(console.log.mock.calls)).not.toContain('SECRETTO');
    } finally {
      process.env.LOGTAIL_TOKEN = originalToken;
    }
  });

  describe('client ID', () => {
    const CLIENT_IP = '203.0.113.7';

    // Runs a request through a token-enabled copy of the middleware and returns what was sent
    async function captureLogEntry(setupApp) {
      const originalFetch = global.fetch;
      const originalToken = process.env.LOGTAIL_TOKEN;
      global.fetch = jest.fn().mockResolvedValue({ ok: true });
      process.env.LOGTAIL_TOKEN = 'test-token';

      try {
        let middleware;
        let logErrorWithToken;
        jest.isolateModules(() => {
          ({ loggingMiddleware: middleware, logError: logErrorWithToken } = require('../middleware/logging'));
        });

        await setupApp(middleware, logErrorWithToken);

        return global.fetch.mock.calls.map(([, options]) => options.body);
      } finally {
        global.fetch = originalFetch;
        process.env.LOGTAIL_TOKEN = originalToken;
      }
    }

    afterEach(() => {
      jest.useRealTimers();
    });

    test('is stable for the same IP on the same day and differs between IPs', () => {
      expect(getClientId(CLIENT_IP)).toBe(getClientId(CLIENT_IP));
      expect(getClientId(CLIENT_IP)).not.toBe(getClientId('203.0.113.8'));
      expect(getClientId(CLIENT_IP)).toMatch(/^[0-9a-f]{16}$/);
    });

    test('changes when the UTC day changes', () => {
      jest.useFakeTimers({ now: new Date('2026-10-31T23:59:59Z') });
      const before = getClientId(CLIENT_IP);

      jest.setSystemTime(new Date('2026-11-01T00:00:00Z'));

      expect(getClientId(CLIENT_IP)).not.toBe(before);
    });

    test('is null when there is no IP', () => {
      expect(getClientId(undefined)).toBeNull();
    });

    test('request logs carry a client ID and never the IP', async () => {
      const [body] = await captureLogEntry(async middleware => {
        const app = express();
        app.set('trust proxy', 'loopback');
        app.use(middleware);
        app.get('/ok', (req, res) => res.json({ ok: true }));
        await request(app).get('/ok').set('X-Forwarded-For', CLIENT_IP);
      });

      const entry = JSON.parse(body);
      expect(entry.clientId).toMatch(/^[0-9a-f]{16}$/);
      expect(entry).not.toHaveProperty('ip');
      expect(body).not.toContain(CLIENT_IP);
    });

    test('error logs carry a client ID and never the IP', async () => {
      const [body] = await captureLogEntry(async (middleware, logErrorWithToken) => {
        logErrorWithToken(new Error('boom'), { ip: CLIENT_IP, originalUrl: '/x', method: 'GET' });
      });

      const entry = JSON.parse(body);
      expect(entry.clientId).toMatch(/^[0-9a-f]{16}$/);
      expect(entry).not.toHaveProperty('ip');
      expect(body).not.toContain(CLIENT_IP);
    });

    test('logError without a request has no client ID and does not throw', () => {
      expect(() => logError(new Error('boom'))).not.toThrow();
    });
  });

  test('a failure while building the log entry does not break the response', async () => {
    const app = express();
    app.use(loggingMiddleware);
    app.get('/ok', (req, res) => {
      req.get = () => {
        throw new Error('log field failure');
      };
      res.json({ ok: true });
    });

    const response = await request(app).get('/ok');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });
});
