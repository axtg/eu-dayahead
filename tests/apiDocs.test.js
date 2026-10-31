const fs = require('fs');
const path = require('path');
const request = require('supertest');

const app = require('../index');

const SAMPLE_PARAMS = { '{country}': 'nl', '{hours}': '6', '{provider}': 'eneco' };

function specPaths() {
  const spec = fs.readFileSync(path.join(__dirname, '../docs/openapi.yaml'), 'utf8');
  return [...spec.matchAll(/^ {2}(\/\S*):$/gm)].map(match => match[1]);
}

// interval=bad stops price routes with a 400 before any upstream call. A missing route returns 404.
async function routeExists(documentedPath) {
  const url = documentedPath.replace(/\{\w+\}/g, param => SAMPLE_PARAMS[param]);
  const { status } = await request(app).get(`${url}?interval=bad`);
  return status !== 404;
}

describe('documented endpoints exist', () => {
  test('every path in the OpenAPI spec', async () => {
    for (const documentedPath of specPaths()) {
      expect([documentedPath, await routeExists(documentedPath)]).toEqual([documentedPath, true]);
    }
  });

  test('every endpoint in the readme', async () => {
    const readme = fs.readFileSync(path.join(__dirname, '../readme.md'), 'utf8');
    const documented = [...readme.matchAll(/`GET (\/[^\s`]*)`/g)].map(match => match[1]);

    expect(documented.length).toBeGreaterThan(3);
    for (const documentedPath of documented) {
      expect([documentedPath, await routeExists(documentedPath)]).toEqual([documentedPath, true]);
    }
  });

  test('the spec covers every price and health route', () => {
    expect(specPaths()).toEqual(
      expect.arrayContaining(['/api/{country}/next24h', '/api/{country}/next/{hours}', '/health/cache'])
    );
  });
});
