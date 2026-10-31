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
  invalidParam,
  pricesUnavailable
} = require('../utils/helpers');

function requireCountry(req) {
  const countryCode = validateCountry(req.params.country);
  if (!countryCode) {
    throw invalidParam(`Unsupported country: ${req.params.country}. Use /api/countries to see supported countries.`);
  }
  return countryCode;
}

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
    const countryCode = requireCountry(req);

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

async function sendNextHours(req, res, countryCode, hours, type, { reportHours = false } = {}) {
  const interval = parseIntervalOption(req.query);
  const markupOptions = parseMarkupOptions(req.query, countryCode);

  const country = COUNTRIES[countryCode];
  const nowInTargetTz = toZonedTime(new Date(), country.timezone);
  const currentHourInTargetTz = startOfHour(nowInTargetTz);
  const currentHourStart = fromZonedTime(currentHourInTargetTz, country.timezone);
  const windowEnd = addHours(currentHourStart, hours);

  const result = await fetchCountryPrices(countryCode, markupOptions, { interval });

  const windowPrices = result.prices.filter(price => {
    const priceTime = new Date(price.time);
    return priceTime >= currentHourStart && priceTime < windowEnd;
  });

  if (windowPrices.length === 0) throw pricesUnavailable();

  const enrichedPrices = enrichPricesWithCountryInfo(windowPrices, countryCode, {
    includeSpanInfo: true,
    referenceTime: currentHourStart
  });

  const actualHours = Math.floor((enrichedPrices.length * result.resolutionMinutes) / 60);
  const hoursInfo = reportHours ? { requestedHours: hours, actualHours } : {};

  res.json(
    buildCountryResponse(countryCode, enrichedPrices, markupOptions, type, {
      startTime: currentHourStart.toISOString(),
      endTime: windowEnd.toISOString(),
      ...hoursInfo,
      source: result.source,
      resolutionMinutes: result.resolutionMinutes,
      warnings: result.warnings
    })
  );
}

router.get('/:country/next24h', async (req, res, next) => {
  try {
    await sendNextHours(req, res, requireCountry(req), 24, 'next24hours');
  } catch (error) {
    next(error);
  }
});

router.get('/:country/next/:hours', async (req, res, next) => {
  try {
    const countryCode = requireCountry(req);

    const hours = /^\d+$/.test(req.params.hours) ? Number(req.params.hours) : NaN;
    if (isNaN(hours) || hours < 1 || hours > 48) throw invalidParam('Hours must be a number between 1 and 48');

    await sendNextHours(req, res, countryCode, hours, `next${hours}hours`, { reportHours: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
