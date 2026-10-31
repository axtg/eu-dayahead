const crypto = require('crypto');
const request = require('supertest');

const app = require('../index');
const { buildContentSecurityPolicy } = require('../middleware/securityHeaders');

const sha256 = source => `'sha256-${crypto.createHash('sha256').update(source).digest('base64')}'`;
const directive = (policy, name) => policy.split('; ').find(part => part.startsWith(`${name} `));

describe('buildContentSecurityPolicy', () => {
  test('allows inline scripts by hash, with their exact whitespace', () => {
    const inline = '\n      window.a = 1;\n    ';

    expect(directive(buildContentSecurityPolicy(`<script>${inline}</script>`), 'script-src')).toContain(sha256(inline));
  });

  test('ignores scripts that load a file and data blocks that never run', () => {
    const html = `
      <script src="/app.js" defer></script>
      <script async src="https://plausible.io/js/x.js"></script>
      <script type="application/ld+json">{"a":1}</script>`;

    expect(directive(buildContentSecurityPolicy(html), 'script-src')).not.toContain('sha256-');
  });
});

describe('security headers', () => {
  test.each(['/', '/app.js', '/api/countries', '/health', '/nope'])('%s carries them', async url => {
    const { headers } = await request(app).get(url);

    expect(headers['content-security-policy']).toContain("default-src 'self'");
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['strict-transport-security']).toBe('max-age=604800');
    expect(headers['x-powered-by']).toBeUndefined();
  });

  test('the policy is enforced', async () => {
    const { headers } = await request(app).get('/');

    expect(headers['content-security-policy']).toBeDefined();
    expect(headers['content-security-policy-report-only']).toBeUndefined();
  });

  describe('script sources', () => {
    let scriptSrc;

    beforeAll(async () => {
      const { headers } = await request(app).get('/');
      scriptSrc = directive(headers['content-security-policy'], 'script-src');
    });

    test('do not allow arbitrary inline scripts', () => {
      expect(scriptSrc).not.toContain("'unsafe-inline'");
    });

    test('allow only one package from jsDelivr, which hosts anything on npm', () => {
      expect(scriptSrc).toContain('https://cdn.jsdelivr.net/npm/chart.js@4.4.4/');
      expect(scriptSrc).not.toMatch(/https:\/\/cdn\.jsdelivr\.net( |$)/);
    });

    test('allow every inline script in the served page', async () => {
      const { text } = await request(app).get('/');
      const inline = [...text.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);

      inline.forEach(source => expect(scriptSrc).toContain(sha256(source)));
    });
  });

  describe('/docs', () => {
    test.each(['/docs', '/docs/', '/DOCS'])('%s has its own policy for Swagger UI', async url => {
      const { headers, text } = await request(app).get(url);
      const policy = headers['content-security-policy'];
      const swagger = 'https://unpkg.com/swagger-ui-dist@5.9.0/';

      expect(directive(policy, 'script-src')).toContain(swagger);
      expect(directive(policy, 'style-src')).toContain(swagger);
      expect(directive(policy, 'script-src')).not.toContain('plausible');
      [...text.matchAll(/<script>([\s\S]*?)<\/script>/g)].forEach(match =>
        expect(directive(policy, 'script-src')).toContain(sha256(match[1]))
      );
    });

    test('the site policy does not allow Swagger UI', async () => {
      const { headers } = await request(app).get('/');

      expect(headers['content-security-policy']).not.toContain('unpkg');
    });

    test('loads nothing from the Swagger demo site', async () => {
      const { text } = await request(app).get('/docs');

      expect(text).not.toContain('petstore.swagger.io');
    });

    test('does not send the spec URL to the Swagger validator', async () => {
      const { text } = await request(app).get('/docs');

      expect(text).toContain('validatorUrl: null');
    });
  });
});

describe('CORS', () => {
  test('a preflight only advertises the methods the API has', async () => {
    const { headers } = await request(app)
      .options('/api/countries')
      .set('Origin', 'https://example.com')
      .set('Access-Control-Request-Method', 'GET')
      .expect(204);

    expect(headers['access-control-allow-origin']).toBe('*');
    expect(headers['access-control-allow-methods']).toBe('GET,HEAD');
  });
});
