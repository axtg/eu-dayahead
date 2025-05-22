const express = require('express');
const cors = require('cors');
const path = require('path');

// Load environment variables
require('dotenv').config();

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

// Health check endpoint
app.get('/health', (req, res) => {
  const { COUNTRIES } = require('./config/countries');
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    supportedCountries: Object.keys(COUNTRIES).length
  });
});

// Mount route handlers
app.use('/api', countryRoutes);
app.use('/api/providers', providerRoutes);
app.use('/api-docs', docsRoutes);

// Serve static documentation files
app.use('/docs', express.static(path.join(__dirname, 'docs')));

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    status: 'error',
    message: 'Endpoint not found. Use /api/countries to see available endpoints.'
  });
});

// Error handler
app.use((error, req, res) => {
  console.error('Server Error:', error);
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

    console.log('\n🇳🇱 NETHERLANDS SHORTCUTS (Backward compatibility):');
    console.log('  GET /api/today - Netherlands today (alias for /api/nl/today)');
    console.log('  GET /api/tomorrow - Netherlands tomorrow');
    console.log('  GET /api/next/24 - Netherlands next 24 hours');

    console.log('\n⚙️  ADVANCED ENDPOINTS:');
    console.log('  GET /api/prices - Current day prices (NL)');
    console.log('  GET /api/prices/:startDate/:endDate - Date range prices (NL)');
    console.log('  GET /api/next/:hours - Next N hours (NL, 1-48)');
    console.log('  GET /api/forecast - Forecast prices (NL)');
    console.log('  GET /api/current - Current hour price (NL)');
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
    console.log('  variableMarkup - Variable markup in % (e.g., 5)');
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
    console.log('  Interactive API Docs: http://localhost:3000/api-docs');
    console.log('  OpenAPI Spec: http://localhost:3000/api-docs/openapi.yaml');

    console.log('\n🔗 Quick test: http://localhost:3000/api/countries');
  });
}

module.exports = app;
