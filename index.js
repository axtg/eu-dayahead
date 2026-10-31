// index.js - Main server file
const express = require('express');
const cors = require('cors');
const path = require('path');

// Load environment variables
require('dotenv').config();

// Import logging middleware
const { loggingMiddleware, logError } = require('./middleware/logging');

// Import rate limiter
const { createRateLimiter, parseRateLimit } = require('./middleware/rateLimit');
const { securityHeaders } = require('./middleware/securityHeaders');

// Import route handlers
const { PRICES_UNAVAILABLE_MESSAGE } = require('./utils/helpers');
const countryRoutes = require('./routes/countries');
const providerRoutes = require('./routes/providers');
const docsRoutes = require('./routes/docs');

const app = express();
const port = process.env.PORT || 3000;

// nginx runs on the same host, so honour X-Forwarded-For only on loopback connections. req.ip is then
// the entry nginx appended; anyone reaching the port directly is identified by their socket address.
// Change this if nginx moves to another host or another proxy is added.
app.set('trust proxy', 'loopback');

app.disable('x-powered-by');

// Middleware
app.use(securityHeaders());
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'HEAD']
  })
);

// Add EU-based Better Stack logging middleware
app.use(loggingMiddleware);

// Serve static frontend (SEO-friendly landing page)
app.use(express.static(path.join(__dirname, 'public')));

// Simple per-IP rate limiter for API routes (X requests/second)
const rateLimiter = createRateLimiter({
  limit: parseRateLimit(process.env.RATE_LIMIT_RPS || process.env.API_RATE_LIMIT_PER_SEC)
});

// Health check endpoint
app.get('/health', (req, res) => {
  const { COUNTRIES } = require('./config/countries');
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    supportedCountries: Object.keys(COUNTRIES).length
  });
});

// Cache health endpoint
app.get('/health/cache', (req, res) => {
  const { getCacheStats } = require('./utils/helpers');
  const stats = getCacheStats();
  res.json({ status: 'success', cache: stats, timestamp: new Date().toISOString() });
});

// Serve OpenAPI spec at root (keep spec, remove Swagger UI)
app.get('/openapi.yaml', (req, res) => {
  res.sendFile(path.join(__dirname, 'docs', 'openapi.yaml'));
});

// Mount API route handlers - ORDER MATTERS!
app.use('/api', rateLimiter, countryRoutes);
app.use('/api/providers', providerRoutes);
app.use('/docs', docsRoutes);

// Fallback to index.html for root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 404 handler for unknown routes (excluding static files already handled)
app.use('*', (req, res) => {
  res.status(404).json({
    status: 'error',
    message: 'Endpoint not found. Use /api/countries to see available endpoints.'
  });
});

// Express only treats a middleware with four arguments as an error handler.
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);

  const status = error.statusCode || error.status || 500;
  const isUpstreamFailure = status === 503;

  // Upstream failures are already logged by the fetch, which many requests can share.
  if (status >= 500 && !isUpstreamFailure) logError(error, req);

  // Only client errors are safe to explain. Other messages can contain internal details.
  let message = 'Internal server error';
  if (status < 500) message = error.message;
  if (isUpstreamFailure) message = PRICES_UNAVAILABLE_MESSAGE;

  return res.status(status).json({ status: 'error', message });
});

// Start server only if this file is run directly
if (require.main === module) {
  app.listen(port, () => {
    const { COUNTRIES } = require('./config/countries');

    console.log(`🌍 European Energy Prices API running at http://localhost:${port}`);
    console.log('\n🎯 ENDPOINTS:');
    console.log('  GET /api/countries - List all supported countries');
    console.log("  GET /api/{country}/today - Today's prices for country");
    console.log('  GET /api/{country}/next24h - Next 24 hours for country');
    console.log('  GET /api/{country}/next/{hours} - Next 1-48 hours for country');
    console.log('  GET /api/providers - List provider presets');
    console.log('  GET /api/providers/{provider}/{country} - Prices with a provider preset');
    console.log('  GET /health - Health check');

    console.log('\n🌍 SUPPORTED COUNTRIES:');
    Object.entries(COUNTRIES).forEach(([code, config]) => {
      const vatPercent = Number((config.defaultVat * 100).toFixed(1));
      console.log(`  ${code.toUpperCase()} - ${config.name} (${config.currency}, VAT: ${vatPercent}%)`);
    });

    console.log('\n📊 QUERY PARAMETERS:');
    console.log('  markup or fixedMarkup - Fixed markup in local currency/kWh (e.g., 0.024)');
    // console.log('  variableMarkup - Variable markup in % (e.g., 5)');
    console.log('  vat - VAT as decimal (e.g., 0.21 for 21%)');
    console.log("  autoVat - Use country's default VAT rate (true/false)");
    console.log('  roundTo - Decimal places to round to (default: 5)');

    console.log('\n📚 DOCUMENTATION:');
    console.log('  OpenAPI Spec: http://localhost:3000/openapi.yaml');

    console.log('\n🔗 Quick test: http://localhost:3000/api/countries');
  });
}

module.exports = app;
