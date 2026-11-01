const express = require('express');
const router = express.Router();

const { COUNTRIES } = require('../config/countries');
const { findCheapestWindow, localDate } = require('../utils/cheapestWindow');
const { buildCalendar } = require('../utils/ics');
const {
  parseMarkupOptions,
  validateCountry,
  fetchCountryPrices,
  invalidParam,
  pricesUnavailable
} = require('../utils/helpers');

const DEFAULT_HOURS = 4;
const DATA_CREDITS = {
  entsoe: 'Data: ENTSOE Transparency Platform, via dap.xadi.eu.',
  stekker: 'Data: Stekker.app, used while ENTSOE is unavailable, via dap.xadi.eu.'
};

function parseWholeNumber(query, name, min, max, fallback) {
  const raw = query[name];
  if (raw === undefined || raw === '') return fallback;
  const value = typeof raw === 'string' && /^\d{1,2}$/.test(raw) ? Number(raw) : NaN;
  if (!(value >= min && value <= max)) {
    throw invalidParam(`Invalid ${name}. Use a whole number from ${min} to ${max}.`);
  }
  return value;
}

function parseWindowOptions(query) {
  if (query.interval !== undefined) {
    throw invalidParam('The calendar feed has no interval option. It always uses the most detailed prices available.');
  }
  const hours = parseWholeNumber(query, 'hours', 1, 24, DEFAULT_HOURS);
  const from = parseWholeNumber(query, 'from', 0, 23, 0);
  const to = parseWholeNumber(query, 'to', 1, 24, 24);
  if (to - from < hours) {
    throw invalidParam(`A ${hours}-hour window doesn't fit between from=${from} and to=${to}.`);
  }
  return { hours, from, to };
}

// Fallback quarter hours can carry stale hourly prices, so those windows use hourly means.
async function fetchFinestPrices(countryCode, markupOptions) {
  const result = await fetchCountryPrices(countryCode, markupOptions, { interval: '15M' });
  if (result.source === 'entsoe') return result;
  return fetchCountryPrices(countryCode, markupOptions, { interval: '60M' });
}

function formatPrice(amount, currency, decimals) {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  }).format(amount);
}

function hasMarkup({ fixedMarkup, variableMarkup, vat }) {
  return fixedMarkup !== 0 || variableMarkup !== 0 || vat !== 0;
}

function windowEvent(window, { countryCode, country, options, markupOptions, source }) {
  const { hours, from, to } = options;
  const priceBasis = hasMarkup(markupOptions) ? 'including your markup and VAT' : 'excluding markup and VAT';
  const average = formatPrice(window.averagePrice, country.currency, 4);

  return {
    uid: `${countryCode}-${window.date}-${hours}h-${from}-${to}@dap.xadi.eu`,
    start: window.start,
    end: window.end,
    summary: `Cheapest ${hours}h · avg ${formatPrice(window.averagePrice, country.currency, 2)}/kWh`,
    description: [
      `Cheapest ${hours}-hour window in ${country.name} on ${window.date}.`,
      `Average ${average}/kWh, ${priceBasis}.`,
      DATA_CREDITS[source]
    ].join('\n')
  };
}

router.get('/:country/calendar.ics', async (req, res, next) => {
  try {
    const countryCode = validateCountry(req.params.country);
    if (!countryCode) {
      throw invalidParam(`Unsupported country: ${req.params.country}. Use /api/countries to see supported countries.`);
    }
    const options = parseWindowOptions(req.query);
    const markupOptions = parseMarkupOptions(req.query, countryCode);
    const country = COUNTRIES[countryCode];

    const { prices, source, resolutionMinutes } = await fetchFinestPrices(countryCode, markupOptions);

    const now = new Date();
    const windows = [0, 1]
      .map(dayOffset =>
        findCheapestWindow(prices, {
          ...options,
          date: localDate(now, country.timezone, dayOffset),
          timezone: country.timezone,
          resolutionMinutes
        })
      )
      .filter(Boolean);

    // A failed sync keeps the events a subscriber has. An empty calendar would delete them.
    if (windows.length === 0) throw pricesUnavailable();

    const context = { countryCode, country, options, markupOptions, source };
    res.type('text/calendar').send(
      buildCalendar({
        name: `Cheapest ${options.hours}h energy window (${countryCode.toUpperCase()})`,
        events: windows.map(window => windowEvent(window, context))
      })
    );
  } catch (error) {
    next(error);
  }
});

module.exports = router;
