// routes/countries.js - Country-specific route handlers
const express = require('express');
const router = express.Router();

const { COUNTRIES } = require('../config/countries');
const {
  parseMarkupOptions,
  validateCountry,
  fetchCountryPrices,
  enrichPricesWithCountryInfo,
  buildCountryResponse
} = require('../utils/helpers');

// List all supported countries
router.get('/countries', (req, res) => {
  const countries = Object.entries(COUNTRIES).map(([code, config]) => ({
    code: code.toUpperCase(),
    name: config.name,
    currency: config.currency,
    timezone: config.timezone,
    defaultVat: config.defaultVat,
    vatPercent: `${Math.round(config.defaultVat * 100)}%`
  }));

  res.json({
    status: 'success',
    data: countries,
    total: countries.length
  });
});

// Get today's prices for a specific country (00:00 - 23:59)
router.get('/:country/today', async (req, res) => {
  try {
    const countryCode = validateCountry(req.params.country);
    if (!countryCode) {
      return res.status(400).json({
        status: 'error',
        message: `Unsupported country: ${req.params.country}. Use /api/countries to see supported countries.`
      });
    }

    const country = COUNTRIES[countryCode];
    const markupOptions = parseMarkupOptions(req.query, countryCode);
    
    // Get today's start and end in country's timezone
    const now = new Date();
    const today = new Date(now.toLocaleString('en-US', { timeZone: country.timezone }));
    
    const todayStart = new Date(today);
    todayStart.setHours(0, 0, 0, 0);
    
    const todayEnd = new Date(today);
    todayEnd.setHours(23, 59, 59, 999);

    const prices = await fetchCountryPrices(countryCode, todayStart, todayEnd, false, markupOptions);
    const enrichedPrices = enrichPricesWithCountryInfo(prices, countryCode);

    const response = buildCountryResponse(countryCode, enrichedPrices, markupOptions, 'today', {
      date: today.toLocaleDateString(country.locale, { timeZone: country.timezone })
    });

    res.json(response);

  } catch (error) {
    console.error(`Error fetching ${req.params.country} today prices:`, error);
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// Get tomorrow's prices for a specific country (00:00 - 23:59)
router.get('/:country/tomorrow', async (req, res) => {
  try {
    const countryCode = validateCountry(req.params.country);
    if (!countryCode) {
      return res.status(400).json({
        status: 'error',
        message: `Unsupported country: ${req.params.country}. Use /api/countries to see supported countries.`
      });
    }

    const country = COUNTRIES[countryCode];
    const markupOptions = parseMarkupOptions(req.query, countryCode);
    
    // Get tomorrow's start and end in country's timezone
    const now = new Date();
    const today = new Date(now.toLocaleString('en-US', { timeZone: country.timezone }));
    
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    const tomorrowStart = new Date(tomorrow);
    tomorrowStart.setHours(0, 0, 0, 0);
    
    const tomorrowEnd = new Date(tomorrow);
    tomorrowEnd.setHours(23, 59, 59, 999);

    const prices = await fetchCountryPrices(countryCode, tomorrowStart, tomorrowEnd, false, markupOptions);
    const enrichedPrices = enrichPricesWithCountryInfo(prices, countryCode);

    const response = buildCountryResponse(countryCode, enrichedPrices, markupOptions, 'tomorrow', {
      date: tomorrow.toLocaleDateString(country.locale, { timeZone: country.timezone })
    });

    res.json(response);

  } catch (error) {
    console.error(`Error fetching ${req.params.country} tomorrow prices:`, error);
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// Get next 24 hours for a specific country
router.get('/:country/next24h', async (req, res) => {
  try {
    const countryCode = validateCountry(req.params.country);
    if (!countryCode) {
      return res.status(400).json({
        status: 'error',
        message: `Unsupported country: ${req.params.country}. Use /api/countries to see supported countries.`
      });
    }

    const country = COUNTRIES[countryCode];
    const markupOptions = parseMarkupOptions(req.query, countryCode);
    const now = new Date();
    
    // Get current hour start in country's timezone
    const countryNow = new Date(now.toLocaleString('en-US', { timeZone: country.timezone }));
    const currentHourStart = new Date(countryNow);
    currentHourStart.setMinutes(0, 0, 0);
    
    // Get 24 hours from now
    const next24HoursEnd = new Date(currentHourStart);
    next24HoursEnd.setHours(next24HoursEnd.getHours() + 24);
    
    // Fetch wider range to ensure we get all needed hours
    const fetchStart = new Date(currentHourStart);
    fetchStart.setDate(fetchStart.getDate() - 1);
    
    const fetchEnd = new Date(next24HoursEnd);
    fetchEnd.setDate(fetchEnd.getDate() + 1);
    
    const allPrices = await fetchCountryPrices(countryCode, fetchStart, fetchEnd, false, markupOptions);
    
    // Filter to get exactly the next 24 hours
    const next24Hours = allPrices.filter(price => {
      const priceTime = new Date(price.time);
      return priceTime >= currentHourStart && priceTime < next24HoursEnd;
    });
    
    const enrichedPrices = enrichPricesWithCountryInfo(next24Hours, countryCode, { includeSpanInfo: true });

    const response = buildCountryResponse(countryCode, enrichedPrices, markupOptions, 'next24hours', {
      startTime: currentHourStart.toISOString(),
      endTime: next24HoursEnd.toISOString()
    });

    res.json(response);

  } catch (error) {
    console.error(`Error fetching ${req.params.country} next 24h prices:`, error);
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// Alias for next24h
router.get('/:country/next/24', (req, res) => {
  const queryString = Object.keys(req.query).length > 0 ? 
    '?' + new URLSearchParams(req.query).toString() : '';
  
  req.url = `/api/${req.params.country}/next24h${queryString}`;
  req.app._router.handle(req, res);
});

module.exports = router;