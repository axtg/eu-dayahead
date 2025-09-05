// index.js - Main server file
const express = require('express');
const cors = require('cors');
const path = require('path');

// Load environment variables
require('dotenv').config();

// Import logging middleware
const { loggingMiddleware, logError } = require('./middleware/logging');

// Import route handlers
const countryRoutes = require('./routes/countries');
const providerRoutes = require('./routes/providers');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || '*'
  })
);
app.use(express.json());

// Add EU-based Better Stack logging middleware
app.use(loggingMiddleware);

// Serve static frontend (SEO-friendly landing page)
app.use(express.static(path.join(__dirname, 'public')));

// Simple per-IP rate limiter for API routes (X requests/second)
const RATE_LIMIT_RPS = parseInt(process.env.RATE_LIMIT_RPS || process.env.API_RATE_LIMIT_PER_SEC || '10', 10);
const __rateBuckets = new Map();
function rateLimiter(req, res, next) {
  const ip = (req.headers['x-forwarded-for']?.split(',')[0] || req.ip || req.connection?.remoteAddress || 'unknown').toString();
  const now = Date.now();
  const windowMs = 1000;
  let bucket = __rateBuckets.get(ip);
  if (!bucket || now - bucket.windowStart >= windowMs) {
    bucket = { count: 0, windowStart: now };
    __rateBuckets.set(ip, bucket);
  }
  bucket.count += 1;

  const remaining = Math.max(RATE_LIMIT_RPS - bucket.count, 0);
  const resetUnixSeconds = Math.ceil((bucket.windowStart + windowMs) / 1000);

  res.set({
    'X-RateLimit-Limit': String(RATE_LIMIT_RPS),
    'X-RateLimit-Remaining': String(remaining),
    'X-RateLimit-Reset': String(resetUnixSeconds)
  });

  if (bucket.count > RATE_LIMIT_RPS) {
    res.set('Retry-After', '1');
    return res.status(429).json({ status: 'error', message: 'Rate limit exceeded. Try again later.', limitPerSecond: RATE_LIMIT_RPS });
  }
  return next();
}

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
app.use('/api/providers', rateLimiter, providerRoutes);

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

// Error handler
app.use((error, req, res) => {
  // Log error to Better Stack
  logError(error, req);

  res.status(500).json({
    status: 'error',
    message: 'Internal server error'
  });
});

// Start server only if this file is run directly
if (require.main === module) {
  app.listen(port, () => {
    const { COUNTRIES } = require('./config/countries');

    console.log(`🌍 European Energy Prices API running at http://localhost:${port}`);
    console.log('\n🎯 COUNTRY-SPECIFIC ENDPOINTS (Recommended):');
    console.log('  GET /api/countries - List all supported countries');
    console.log("  GET /api/{country}/today - Today's prices for country");
    console.log("  GET /api/{country}/tomorrow - Tomorrow's prices for country");
    console.log('  GET /api/{country}/next24h - Next 24 hours for country');

    console.log('\n🇳🇱 NL SHORTCUTS:');
    console.log('  GET /api/today - Netherlands today (alias for /api/nl/today)');
    console.log('  GET /api/next/24 - Netherlands next 24 hours');
    console.log('  GET /api/providers/next-energy - Next Energy preset');
    console.log('  GET /health - Health check');

    console.log('\n🌍 SUPPORTED COUNTRIES:');
    Object.entries(COUNTRIES).forEach(([code, config]) => {
      console.log(
        `  ${code.toUpperCase()} - ${config.name} (${config.currency}, VAT: ${Math.round(config.defaultVat * 100)}%)`
      );
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
