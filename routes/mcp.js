const express = require('express');
const { createMcpHandler, McpServer } = require('@modelcontextprotocol/server');
const { toNodeHandler } = require('@modelcontextprotocol/node');
const { formatInTimeZone } = require('date-fns-tz');
const { z } = require('zod');

const { COUNTRIES } = require('../config/countries');
const { findUpcomingWindow, hasCompleteDay, localDate } = require('../utils/cheapestWindow');
const {
  PRICES_UNAVAILABLE_MESSAGE,
  fetchCountryPrices,
  fetchFinestPrices,
  parseMarkupOptions
} = require('../utils/helpers');
const { logError } = require('../middleware/logging');
const { version } = require('../package.json');

const HOUR_MS = 3_600_000;
const MAX_REQUEST_BYTES = 64 * 1024;
const READ_ONLY = { readOnlyHint: true, openWorldHint: false };
const DATA_SOURCES = {
  entsoe: 'ENTSOE Transparency Platform',
  stekker: 'Stekker.app, used while ENTSOE is unavailable'
};

const INSTRUCTIONS = `Day-ahead electricity prices for European countries. Prices are in EUR/kWh and all times are local
to the country. If you don't know the user's country, ask for it instead of guessing. Say when a price excludes markup
and VAT, unless the user only asked about timing.`;

const countryCode = z
  .enum(Object.keys(COUNTRIES))
  .describe("Lowercase country code. If you don't know the user's country, ask for it instead of guessing.");

const priceOptions = {
  markup: z
    .number()
    .optional()
    .describe("The user's fixed contract markup in EUR/kWh, before VAT. Only if they gave it."),
  includeVat: z.boolean().optional().describe("Add the country's default VAT to the prices.")
};

const windowInput = z.object({
  country: countryCode,
  hours: z.number().min(0.25).max(24).describe('How long the appliance runs. Parts of an hour are allowed, like 3.5.'),
  day: z
    .enum(['today', 'tomorrow'])
    .default('today')
    .describe('The day the appliance starts. Today only looks at start times still ahead.'),
  from: z.number().int().min(0).max(23).optional().describe('Earliest local start hour on that day, such as 7.'),
  to: z
    .number()
    .int()
    .min(1)
    .max(24)
    .optional()
    .describe('Latest local finish hour on that day. Leave it out to allow a finish after midnight.'),
  ...priceOptions
});

const pricesInput = z.object({
  country: countryCode,
  nextHours: z
    .number()
    .int()
    .min(1)
    .max(48)
    .optional()
    .describe('Prices from the current hour for this many hours. Leave it out for all of today.'),
  interval: z.enum(['60M', '15M']).default('60M').describe('Hourly means, or quarter hours where available.'),
  ...priceOptions
});

function localTime(time, timezone) {
  return formatInTimeZone(time, timezone, "yyyy-MM-dd'T'HH:mmxxx");
}

function parsePriceOptions({ markup, includeVat }, country) {
  const query = {};
  if (markup !== undefined) query.markup = String(markup);
  if (includeVat !== undefined) query.includeVat = String(includeVat);
  return parseMarkupOptions(query, country);
}

function priceBasis({ fixedMarkup, variableMarkup, vat }) {
  return fixedMarkup !== 0 || variableMarkup !== 0 || vat !== 0
    ? 'including your markup and VAT'
    : 'excluding markup and VAT';
}

function roundPrice(price) {
  return Number(price.toFixed(4));
}

function toolResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function toolError(error) {
  const status = error.statusCode || 500;
  if (status >= 500 && status !== 503) logError(error);
  let message = 'Internal server error';
  if (status < 500) message = error.message;
  if (status === 503) message = PRICES_UNAVAILABLE_MESSAGE;
  return { ...toolResult({ error: message }), isError: true };
}

// The SDK would return the message of any thrown error, and those can contain internal details.
function safely(handler) {
  return async args => {
    try {
      return toolResult(await handler(args));
    } catch (error) {
      return toolError(error);
    }
  };
}

function windowUnavailableReason({ day, hours, date, country, prices, resolutionMinutes }) {
  if (!hasCompleteDay(prices, { date, timezone: country.timezone, resolutionMinutes })) {
    return day === 'tomorrow'
      ? `Tomorrow's prices for ${country.name} aren't published yet. They're normally available from 14:30 CET.`
      : `Not all of today's prices for ${country.name} are available right now.`;
  }
  return `No ${hours}-hour window fits the rest of ${day} within the known prices and the given hours.`;
}

async function findWindow(args) {
  const { country: code, hours, day, from, to } = args;
  const country = COUNTRIES[code];
  const { timezone } = country;
  const markupOptions = parsePriceOptions(args, code);
  const { prices, source, resolutionMinutes, warnings } = await fetchFinestPrices(code, markupOptions);

  const now = new Date();
  const date = localDate(now, timezone, day === 'tomorrow' ? 1 : 0);
  const window = findUpcomingWindow(prices, { date, timezone, hours, resolutionMinutes, now, from, to });
  if (!window) {
    const reason = windowUnavailableReason({ day, hours, date, country, prices, resolutionMinutes });
    return { available: false, reason };
  }

  const windowHours = (Date.parse(window.end) - Date.parse(window.start)) / HOUR_MS;
  return {
    available: true,
    country: country.name,
    timezone,
    checkedAt: localTime(now, timezone),
    hours: windowHours,
    ...(windowHours !== hours && { requestedHours: hours }),
    start: localTime(window.start, timezone),
    end: localTime(window.end, timezone),
    averagePricePerKwh: roundPrice(window.averagePrice),
    currency: country.currency,
    priceBasis: priceBasis(markupOptions),
    dataSource: DATA_SOURCES[source],
    ...(warnings && { warnings })
  };
}

function isInRange(now, timezone, nextHours) {
  if (nextHours === undefined) {
    const today = localDate(now, timezone);
    return ({ time }) => localDate(new Date(time), timezone) === today;
  }
  const start = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;
  const end = start + nextHours * HOUR_MS;
  return ({ time }) => {
    const ms = new Date(time).getTime();
    return ms >= start && ms < end;
  };
}

async function getPrices(args) {
  const { country: code, nextHours, interval } = args;
  const country = COUNTRIES[code];
  const { timezone } = country;
  const markupOptions = parsePriceOptions(args, code);
  const { prices, source, resolutionMinutes, warnings } = await fetchCountryPrices(code, markupOptions, { interval });

  const inRange = prices.filter(isInRange(new Date(), timezone, nextHours));
  if (inRange.length === 0) return { available: false, reason: `No prices for ${country.name} in that period.` };

  return {
    available: true,
    country: country.name,
    timezone,
    currency: country.currency,
    resolutionMinutes,
    priceBasis: priceBasis(markupOptions),
    dataSource: DATA_SOURCES[source],
    ...(warnings && { warnings }),
    prices: inRange.map(({ time, price }) => ({ time: localTime(time, timezone), pricePerKwh: roundPrice(price) }))
  };
}

function listCountries() {
  return {
    countries: Object.entries(COUNTRIES).map(([code, { name, timezone, currency, defaultVat }]) => ({
      code,
      name,
      timezone,
      currency,
      defaultVat
    }))
  };
}

function createServer() {
  const server = new McpServer({ name: 'eu-day-ahead-prices', version }, { instructions: INSTRUCTIONS });

  server.registerTool(
    'find_cheapest_window',
    {
      description:
        'Find the cheapest time to run an appliance, such as a dishwasher or washing machine: the continuous block ' +
        'of hours with the lowest average day-ahead price that starts on the given day, never in the past. It can ' +
        'finish after midnight unless `to` is set. Markup and VAT only change the price shown, not the timing.',
      inputSchema: windowInput,
      annotations: READ_ONLY
    },
    safely(findWindow)
  );

  server.registerTool(
    'get_prices',
    {
      description:
        "Get day-ahead electricity prices for all of today, or for the next hours, in the country's local time.",
      inputSchema: pricesInput,
      annotations: READ_ONLY
    },
    safely(getPrices)
  );

  server.registerTool(
    'list_countries',
    {
      description: 'List the supported countries with their codes, timezones and default VAT.',
      inputSchema: z.object({}),
      annotations: READ_ONLY
    },
    safely(listCountries)
  );

  return server;
}

// A new server per request and no sessions. Current clients get plain JSON. The SDK always answers 2025-era
// clients with a short event stream, which closes after its one message. Listen streams would stay open
// indefinitely, and the tools never change, so maxSubscriptions refuses them all.
const handler = toNodeHandler(createMcpHandler(createServer, { responseMode: 'json', maxSubscriptions: 0 }));

// A batch counts as one request for the rate limiter however many tool calls it holds.
function refuseBatches(req, res, next) {
  if (!Array.isArray(req.body)) return next();
  return res.status(400).json({
    jsonrpc: '2.0',
    id: null,
    error: { code: -32600, message: 'Batches are not supported.' }
  });
}

function runHandler(req, res, next) {
  handler(req, res, req.body).catch(next);
}

module.exports = [express.json({ limit: MAX_REQUEST_BYTES }), refuseBatches, runHandler];
