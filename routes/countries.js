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
  buildCountryResponse,
  pricesUnavailable
} = require('../utils/helpers');

router.get('/countries', (req, res) => {
  const countries = Object.entries(COUNTRIES).map(([code, config]) => ({
    code: code.toUpperCase(),
    name: config.name,
    currency: config.currency,
    timezone: config.timezone,
    defaultVat: config.defaultVat,
    vatPercent: `${Number((config.defaultVat * 100).toFixed(1))}%`
  }));

  res.json({ status: 'success', data: countries, total: countries.length });
});

router.get('/:country/today', async (req, res, next) => {
  try {
    const countryCode = validateCountry(req.params.country);
    if (!countryCode) {
      return res.status(400).json({
        status: 'error',
        message: `Unsupported country: ${req.params.country}. Use /api/countries to see supported countries.`
      });
    }

    const interval = parseIntervalOption(req.query);
    const markupOptions = parseMarkupOptions(req.query, countryCode);

    const country = COUNTRIES[countryCode];

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
    next(error);
  }
});

router.get('/:country/next24h', async (req, res, next) => {
  try {
    const countryCode = validateCountry(req.params.country);
    if (!countryCode) {
      return res.status(400).json({
        status: 'error',
        message: `Unsupported country: ${req.params.country}. Use /api/countries to see supported countries.`
      });
    }

    const interval = parseIntervalOption(req.query);
    const markupOptions = parseMarkupOptions(req.query, countryCode);

    const country = COUNTRIES[countryCode];
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

    if (next24Hours.length === 0) throw pricesUnavailable();

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
    next(error);
  }
});

router.get('/:country/next/:hours', async (req, res, next) => {
  try {
    const countryCode = validateCountry(req.params.country);
    if (!countryCode) {
      return res.status(400).json({
        status: 'error',
        message: `Unsupported country: ${req.params.country}. Use /api/countries to see supported countries.`
      });
    }

    const hours = /^\d+$/.test(req.params.hours) ? Number(req.params.hours) : NaN;
    if (isNaN(hours) || hours < 1 || hours > 48) {
      return res.status(400).json({ status: 'error', message: 'Hours must be a number between 1 and 48' });
    }

    const interval = parseIntervalOption(req.query);
    const markupOptions = parseMarkupOptions(req.query, countryCode);

    const country = COUNTRIES[countryCode];
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

    if (nextHours.length === 0) throw pricesUnavailable();

    const enrichedPrices = enrichPricesWithCountryInfo(nextHours, countryCode, {
      includeSpanInfo: true,
      referenceTime: currentHourStart
    });

    const response = buildCountryResponse(countryCode, enrichedPrices, markupOptions, `next${hours}hours`, {
      startTime: currentHourStart.toISOString(),
      endTime: nextHoursEnd.toISOString(),
      requestedHours: hours,
      actualHours: Math.floor((enrichedPrices.length * result.resolutionMinutes) / 60),
      source: result.source,
      resolutionMinutes: result.resolutionMinutes,
      warnings: result.warnings
    });

    res.json(response);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
