const express = require('express');
const router = express.Router();
const { fromZonedTime, toZonedTime } = require('date-fns-tz');
const { startOfHour, addHours, addDays, startOfDay, endOfDay } = require('date-fns');

const { COUNTRIES } = require('../config/countries');
const {
  parseMarkupOptions,
  parseIntervalOption,
  parseBestPeriodHours,
  parseBooleanParam,
  findBestPeriod,
  validateCountry,
  enrichPricesWithCountryInfo,
  buildCountryResponse,
  invalidParam,
  pricesUnavailable
} = require('../utils/helpers');
const { fetchPricesWithWindSolar } = require('../utils/windSolar');

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

function bestPeriodFor(prices, bestPeriodHours, result, markupOptions) {
  if (bestPeriodHours === undefined) return undefined;
  return findBestPeriod(prices, bestPeriodHours, result.resolutionMinutes, markupOptions.roundTo);
}

// A whole local day, dayOffset days from today. Going through wall-clock time keeps 23- and 25-hour days correct.
async function sendLocalDay(req, res, dayOffset, type) {
  const countryCode = requireCountry(req);

  const interval = parseIntervalOption(req.query);
  const bestPeriodHours = parseBestPeriodHours(req.query);
  const includeWindSolar = parseBooleanParam(req.query, 'includeWindSolar');
  const markupOptions = parseMarkupOptions(req.query, countryCode);

  const country = COUNTRIES[countryCode];

  const dayInTargetTz = addDays(toZonedTime(new Date(), country.timezone), dayOffset);
  const dayStart = fromZonedTime(startOfDay(dayInTargetTz), country.timezone);
  const dayEnd = fromZonedTime(endOfDay(dayInTargetTz), country.timezone);

  const result = await fetchPricesWithWindSolar(countryCode, markupOptions, { interval }, includeWindSolar);

  const dayPrices = result.prices.filter(price => {
    const priceTime = new Date(price.time);
    return priceTime >= dayStart && priceTime <= dayEnd;
  });

  const enrichedPrices = enrichPricesWithCountryInfo(dayPrices, countryCode);

  res.json(
    buildCountryResponse(countryCode, enrichedPrices, markupOptions, type, {
      date: dayStart.toLocaleDateString(country.locale, { timeZone: country.timezone }),
      source: result.source,
      resolutionMinutes: result.resolutionMinutes,
      warnings: result.warnings,
      bestPeriod: bestPeriodFor(enrichedPrices, bestPeriodHours, result, markupOptions)
    })
  );
}

router.get('/:country/today', async (req, res, next) => {
  try {
    await sendLocalDay(req, res, 0, 'today');
  } catch (error) {
    next(error);
  }
});

router.get('/:country/tomorrow', async (req, res, next) => {
  try {
    await sendLocalDay(req, res, 1, 'tomorrow');
  } catch (error) {
    next(error);
  }
});

async function sendNextHours(req, res, countryCode, hours, type, { reportHours = false } = {}) {
  const interval = parseIntervalOption(req.query);
  const bestPeriodHours = parseBestPeriodHours(req.query);
  const includeWindSolar = parseBooleanParam(req.query, 'includeWindSolar');
  const markupOptions = parseMarkupOptions(req.query, countryCode);

  const country = COUNTRIES[countryCode];
  const nowInTargetTz = toZonedTime(new Date(), country.timezone);
  const currentHourInTargetTz = startOfHour(nowInTargetTz);
  const currentHourStart = fromZonedTime(currentHourInTargetTz, country.timezone);
  const windowEnd = addHours(currentHourStart, hours);

  const result = await fetchPricesWithWindSolar(countryCode, markupOptions, { interval }, includeWindSolar);

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
      warnings: result.warnings,
      bestPeriod: bestPeriodFor(enrichedPrices, bestPeriodHours, result, markupOptions)
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
