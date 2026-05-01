const express = require('express');
const router = express.Router();
const { fromZonedTime, toZonedTime } = require('date-fns-tz');
const { startOfHour, addHours, startOfDay, endOfDay } = require('date-fns');

const { COUNTRIES } = require('../config/countries');
const {
  parseMarkupOptions,
  parseIntervalOption,
  validateCountry,
  fetchCountryPrices,
  enrichPricesWithCountryInfo,
  buildCountryResponse
} = require('../utils/helpers');

function handleParamError(res, err) {
  if (err && err.statusCode) {
    return res.status(err.statusCode).json({ status: 'error', message: err.message });
  }
  return null;
}

router.get('/countries', (req, res) => {
  const countries = Object.entries(COUNTRIES).map(([code, config]) => ({
    code: code.toUpperCase(),
    name: config.name,
    currency: config.currency,
    timezone: config.timezone,
    defaultVat: config.defaultVat,
    vatPercent: `${Math.round(config.defaultVat * 100)}%`
  }));

  res.json({ status: 'success', data: countries, total: countries.length });
});

router.get('/:country/today', async (req, res) => {
  try {
    const countryCode = validateCountry(req.params.country);
    if (!countryCode) {
      return res.status(400).json({
        status: 'error',
        message: `Unsupported country: ${req.params.country}. Use /api/countries to see supported countries.`
      });
    }

    let interval;
    try {
      interval = parseIntervalOption(req.query);
    } catch (err) {
      const handled = handleParamError(res, err);
      if (handled !== null) return;
      throw err;
    }

    const country = COUNTRIES[countryCode];
    const markupOptions = parseMarkupOptions(req.query, countryCode);

    const now = new Date();
    const nowInTargetTz = toZonedTime(now, country.timezone);
    const todayStartInTargetTz = startOfDay(nowInTargetTz);
    const todayEndInTargetTz = endOfDay(nowInTargetTz);
    const todayStart = fromZonedTime(todayStartInTargetTz, country.timezone);
    const todayEnd = fromZonedTime(todayEndInTargetTz, country.timezone);

    const result = await fetchCountryPrices(countryCode, markupOptions, { interval });

    const todayPrices = result.prices.filter(price => {
      const priceTime = new Date(price.time);
      return priceTime >= todayStart && priceTime <= todayEnd;
    });

    const enrichedPrices = enrichPricesWithCountryInfo(todayPrices, countryCode);

    const response = buildCountryResponse(countryCode, enrichedPrices, markupOptions, 'today', {
      date: now.toLocaleDateString(country.locale, { timeZone: country.timezone }),
      source: result.source,
      resolutionMinutes: result.resolutionMinutes,
      warnings: result.warnings
    });

    res.json(response);
  } catch (error) {
    console.error(`Error fetching ${req.params.country} today prices:`, error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

router.get('/:country/next24h', async (req, res) => {
  try {
    const countryCode = validateCountry(req.params.country);
    if (!countryCode) {
      return res.status(400).json({
        status: 'error',
        message: `Unsupported country: ${req.params.country}. Use /api/countries to see supported countries.`
      });
    }

    let interval;
    try {
      interval = parseIntervalOption(req.query);
    } catch (err) {
      const handled = handleParamError(res, err);
      if (handled !== null) return;
      throw err;
    }

    const country = COUNTRIES[countryCode];
    const markupOptions = parseMarkupOptions(req.query, countryCode);
    const now = new Date();

    const nowInTargetTz = toZonedTime(now, country.timezone);
    const currentHourInTargetTz = startOfHour(nowInTargetTz);
    const currentHourStart = fromZonedTime(currentHourInTargetTz, country.timezone);
    const next24HoursEnd = addHours(currentHourStart, 24);

    const result = await fetchCountryPrices(countryCode, markupOptions, { interval });

    const next24Hours = result.prices.filter(price => {
      const priceTime = new Date(price.time);
      return priceTime >= currentHourStart && priceTime < next24HoursEnd;
    });

    const enrichedPrices = enrichPricesWithCountryInfo(next24Hours, countryCode, {
      includeSpanInfo: true,
      referenceTime: currentHourStart
    });

    const response = buildCountryResponse(countryCode, enrichedPrices, markupOptions, 'next24hours', {
      startTime: currentHourStart.toISOString(),
      endTime: next24HoursEnd.toISOString(),
      source: result.source,
      resolutionMinutes: result.resolutionMinutes,
      warnings: result.warnings
    });

    res.json(response);
  } catch (error) {
    console.error(`Error fetching ${req.params.country} next 24h prices:`, error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

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
    if (isNaN(hours) || hours < 1 || hours > 48) {
      return res.status(400).json({ status: 'error', message: 'Hours must be a number between 1 and 48' });
    }

    let interval;
    try {
      interval = parseIntervalOption(req.query);
    } catch (err) {
      const handled = handleParamError(res, err);
      if (handled !== null) return;
      throw err;
    }

    const country = COUNTRIES[countryCode];
    const markupOptions = parseMarkupOptions(req.query, countryCode);
    const now = new Date();

    const nowInTargetTz = toZonedTime(now, country.timezone);
    const currentHourInTargetTz = startOfHour(nowInTargetTz);
    const currentHourStart = fromZonedTime(currentHourInTargetTz, country.timezone);
    const nextHoursEnd = addHours(currentHourStart, hours);

    const result = await fetchCountryPrices(countryCode, markupOptions, { interval });

    const nextHours = result.prices.filter(price => {
      const priceTime = new Date(price.time);
      return priceTime >= currentHourStart && priceTime < nextHoursEnd;
    });

    const enrichedPrices = enrichPricesWithCountryInfo(nextHours, countryCode, {
      includeSpanInfo: true,
      referenceTime: currentHourStart
    });

    const response = buildCountryResponse(countryCode, enrichedPrices, markupOptions, `next${hours}hours`, {
      startTime: currentHourStart.toISOString(),
      endTime: nextHoursEnd.toISOString(),
      requestedHours: hours,
      actualHours: result.resolutionMinutes === 15 ? Math.floor(enrichedPrices.length / 4) : enrichedPrices.length,
      source: result.source,
      resolutionMinutes: result.resolutionMinutes,
      warnings: result.warnings
    });

    res.json(response);
  } catch (error) {
    console.error(`Error fetching ${req.params.country} next ${req.params.hours}h prices:`, error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

module.exports = router;
