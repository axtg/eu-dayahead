const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const express = require('express');
const request = require('supertest');

const { loggingMiddleware } = require('../middleware/logging');

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
