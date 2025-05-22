// index.js - Main server file
const express = require('express');
const cors = require('cors');

// Load environment variables
require('dotenv').config();

// Import logging middleware
const { loggingMiddleware, logError } = require('./middleware/logging');

// Import route handlers
const countryRoutes = require('./routes/countries');
const providerRoutes = require('./routes/providers');
const docsRoutes = require('./routes/docs');

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

// Health check endpoint
app.get('/health', (req, res) => {
  const { COUNTRIES } = require('./config/countries');
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    supportedCountries: Object.keys(COUNTRIES).length
  });
});

// Mount route handlers - ORDER MATTERS!
app.use('/docs', docsRoutes);
app.use('/api', countryRoutes);
app.use('/api/providers', providerRoutes);

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    status: 'error',
    message: 'Endpoint not found. Use /api/countries to see available endpoints.'
  });
});

// Error handler
app.use((error, req, res, next) => {
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
    console.log('  GET /api/tomorrow - Netherlands tomorrow');
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

    console.log('\n✨ EXAMPLES:');
    console.log('  /api/nl/today?markup=0.024&vat=0.21');
    console.log('  /api/de/tomorrow?autoVat=true');
    console.log('  /api/fr/next24h?fixedMarkup=0.030&variableMarkup=5');
    console.log('  /api/be/today?markup=0.025&vat=0.21');
    console.log('  /api/ch/tomorrow?markup=0.035&vat=0.077');

    console.log('\n📚 DOCUMENTATION:');
    console.log('  Interactive API Docs: http://localhost:3000/docs');
    console.log('  OpenAPI Spec: http://localhost:3000/docs/openapi.yaml');

    console.log('\n🔗 Quick test: http://localhost:3000/api/countries');
  });
}

module.exports = app;
