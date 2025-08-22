const express = require('express');
const router = express.Router();
const { fromZonedTime, toZonedTime } = require('date-fns-tz');
const { startOfHour, addHours, startOfDay, endOfDay } = require('date-fns');

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

    // Get today's start and end in country's timezone using date-fns-tz
    // Convert current UTC time to target timezone
    const nowInTargetTz = toZonedTime(now, country.timezone);

    // Get start and end of today in target timezone
    const todayStartInTargetTz = startOfDay(nowInTargetTz);
    const todayEndInTargetTz = endOfDay(nowInTargetTz);

    // Convert back to UTC for API processing
    const todayStart = fromZonedTime(todayStartInTargetTz, country.timezone);
    const todayEnd = fromZonedTime(todayEndInTargetTz, country.timezone);

    // Fetch wider range to ensure we get all needed hours (Stekker API adds extra day)
    const fetchStart = new Date(todayStart);
    fetchStart.setDate(fetchStart.getDate() - 1);

    const fetchEnd = new Date(todayEnd);
    fetchEnd.setDate(fetchEnd.getDate() + 1);

    const allPrices = await fetchCountryPrices(countryCode, fetchStart, fetchEnd, false, markupOptions);

    // Filter to get exactly today's hours (00:00 to 23:59 in target timezone)
    const todayPrices = allPrices.filter(price => {
      const priceTime = new Date(price.time);
      return priceTime >= todayStart && priceTime <= todayEnd;
    });

    const enrichedPrices = enrichPricesWithCountryInfo(todayPrices, countryCode);

    const response = buildCountryResponse(countryCode, enrichedPrices, markupOptions, 'today', {
      date: now.toLocaleDateString(country.locale, { timeZone: country.timezone })
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

    // Get current hour start in country's timezone using date-fns-tz
    // Convert current UTC time to target timezone
    const nowInTargetTz = toZonedTime(now, country.timezone);

    // Get the start of the current hour in target timezone
    const currentHourInTargetTz = startOfHour(nowInTargetTz);

    // Convert back to UTC for API processing
    const currentHourStart = fromZonedTime(currentHourInTargetTz, country.timezone);

    // Get 24 hours from current hour start
    const next24HoursEnd = addHours(currentHourStart, 24);

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

// Get next N hours for a specific country
router.get('/:country/next/:hours', async (req, res) => {
  try {
    const countryCode = validateCountry(req.params.country);
    if (!countryCode) {
      return res.status(400).json({
        status: 'error',
        message: `Unsupported country: ${req.params.country}. Use /api/countries to see supported countries.`
      });
    }

    const hours = parseInt(req.params.hours);
    const markupOptions = parseMarkupOptions(req.query, countryCode);

    if (isNaN(hours) || hours < 1 || hours > 48) {
      return res.status(400).json({
        status: 'error',
        message: 'Hours must be a number between 1 and 48'
      });
    }

    const country = COUNTRIES[countryCode];
    const now = new Date();

    // Get current hour start in country's timezone using date-fns-tz
    // Convert current UTC time to target timezone
    const nowInTargetTz = toZonedTime(now, country.timezone);

    // Get the start of the current hour in target timezone
    const currentHourInTargetTz = startOfHour(nowInTargetTz);

    // Convert back to UTC for API processing
    const currentHourStart = fromZonedTime(currentHourInTargetTz, country.timezone);

    // Get N hours from current hour start
    const nextHoursEnd = addHours(currentHourStart, hours);

    // Fetch wider range to ensure we get all needed hours
    const fetchStart = new Date(currentHourStart);
    fetchStart.setDate(fetchStart.getDate() - 1);

    const fetchEnd = new Date(nextHoursEnd);
    fetchEnd.setDate(fetchEnd.getDate() + 1);

    const allPrices = await fetchCountryPrices(countryCode, fetchStart, fetchEnd, false, markupOptions);

    // Filter to get exactly the next N hours
    const nextHours = allPrices.filter(price => {
      const priceTime = new Date(price.time);
      return priceTime >= currentHourStart && priceTime < nextHoursEnd;
    });

    const enrichedPrices = enrichPricesWithCountryInfo(nextHours, countryCode, { includeSpanInfo: true });

    const response = buildCountryResponse(countryCode, enrichedPrices, markupOptions, `next${hours}hours`, {
      startTime: currentHourStart.toISOString(),
      endTime: nextHoursEnd.toISOString(),
      requestedHours: hours,
      actualHours: enrichedPrices.length
    });

    res.json(response);
  } catch (error) {
    console.error(`Error fetching ${req.params.country} next ${req.params.hours}h prices:`, error);
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// Alias for next24h
router.get('/:country/next/24', (req, res) => {
  const queryString = Object.keys(req.query).length > 0 ? '?' + new URLSearchParams(req.query).toString() : '';

  req.url = `/api/${req.params.country}/next24h${queryString}`;
  req.app._router.handle(req, res);
});

module.exports = router;
