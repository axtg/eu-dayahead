const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Scripts without a src, excluding data blocks such as JSON-LD, which browsers never run.
const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)(?![^>]*\btype=["']application\/ld\+json["'])[^>]*>([\s\S]*?)<\/script>/g;

// Blocks anything not listed. To debug a policy without breaking pages, switch to Content-Security-Policy-Report-Only.
const POLICY_HEADER = 'Content-Security-Policy';

const SITE_SOURCES = {
  scripts: [
    'https://plausible.io',
    'https://cdn.jsdelivr.net/npm/chart.js@4.4.4/' // jsDelivr serves all of npm, so allow only this package
  ],
  connect: ['https://plausible.io']
};

const SWAGGER_UI = 'https://unpkg.com/swagger-ui-dist@5.9.0/'; // unpkg also serves all of npm
const DOCS_SOURCES = { scripts: [SWAGGER_UI], styles: ["'unsafe-inline'", SWAGGER_UI] }; // Swagger UI injects styles

// A hash covers a script's exact text. Pages are hashed at startup, so policies stay in step with them.
function buildContentSecurityPolicy(html, { scripts = [], styles = [], connect = [] } = {}) {
  const inlineHashes = [...html.matchAll(INLINE_SCRIPT)].map(([, source]) => {
    return `'sha256-${crypto.createHash('sha256').update(source).digest('base64')}'`;
  });

  return [
    "default-src 'self'",
    ["script-src 'self'", ...scripts, ...inlineHashes].join(' '),
    ["style-src 'self'", ...styles].join(' '),
    "img-src 'self' data:",
    ["connect-src 'self'", ...connect].join(' '),
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'"
  ].join('; ');
}

function pagePolicy(file, sources) {
  return buildContentSecurityPolicy(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), sources);
}

function securityHeaders() {
  const sitePolicy = pagePolicy('public/index.html', SITE_SOURCES);
  const docsPolicy = pagePolicy('docs/index.html', DOCS_SOURCES);

  return (req, res, next) => {
    res.setHeader(POLICY_HEADER, /^\/docs(\/|$)/i.test(req.path) ? docsPolicy : sitePolicy);
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Strict-Transport-Security', 'max-age=604800'); // One week, while this is new
    next();
  };
}

module.exports = { buildContentSecurityPolicy, securityHeaders };
