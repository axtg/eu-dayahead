const { fromZonedTime, toZonedTime } = require('date-fns-tz');
const { startOfDay } = require('date-fns');

const { COUNTRIES } = require('../config/countries');
const { StekkerAPI } = require('../stekker');
const { EntsoeAPI } = require('../entsoe');

const ENTSOE_API_KEY = process.env.ENTSOE_API_KEY;
const VALID_INTERVALS = new Set(['60M', '15M']);

// ENTSOE day-ahead auction results publish around 14:00 CET; pad to 14:30.
// Day X+2 prices land in the afternoon of day X, so an entry created in the
// morning needs to refresh after this boundary to pick them up.
const ENTSOE_PUBLISH_HOUR_CET = 14;
const ENTSOE_PUBLISH_MINUTE_CET = 30;
const ENTSOE_PUBLISH_TZ = 'Europe/Brussels';

// key -> { refreshAfter, data: { source, prices, upstreamErrors? } }
const __rawCache = new Map();

function localDateInTz(date, timezone) {
  const z = toZonedTime(date, timezone);
  const yyyy = z.getFullYear();
  const mm = String(z.getMonth() + 1).padStart(2, '0');
  const dd = String(z.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function dailyCacheKey(countryCode, now) {
  return `${countryCode}|${localDateInTz(now, COUNTRIES[countryCode].timezone)}`;
}

// Single canonical upstream window per country per day, wide enough to cover
// /today, /next24h, and /next/N (N≤48). All endpoints filter the result
// themselves; this is just the raw fetch boundary.
function canonicalFetchWindow(countryCode, now) {
  const tz = COUNTRIES[countryCode].timezone;
  const todayStartInTz = startOfDay(toZonedTime(now, tz));
  const startInTz = new Date(todayStartInTz);
  startInTz.setDate(startInTz.getDate() - 1);
  const endInTz = new Date(todayStartInTz);
  endInTz.setDate(endInTz.getDate() + 3);
  return { start: fromZonedTime(startInTz, tz), end: fromZonedTime(endInTz, tz) };
}

// Before today's 14:30 CET: refresh at 14:30 CET (so we pick up the next
// auction). After 14:30 CET: cache is good until midnight in the country's
// timezone, when the daily key rolls over and a fresh fetch happens.
function computeRefreshAfter(countryCode, now) {
  const country = COUNTRIES[countryCode];

  const cetNow = toZonedTime(now, ENTSOE_PUBLISH_TZ);
  const cetPublishToday = new Date(cetNow);
  cetPublishToday.setHours(ENTSOE_PUBLISH_HOUR_CET, ENTSOE_PUBLISH_MINUTE_CET, 0, 0);
  const publishUtc = fromZonedTime(cetPublishToday, ENTSOE_PUBLISH_TZ).getTime();
  if (now.getTime() < publishUtc) return publishUtc;

  const tomorrowStartInTz = startOfDay(toZonedTime(now, country.timezone));
  tomorrowStartInTz.setDate(tomorrowStartInTz.getDate() + 1);
  return fromZonedTime(tomorrowStartInTz, country.timezone).getTime();
}

function parseMarkupOptions(query, country) {
  const countryConfig = COUNTRIES[country] || COUNTRIES.nl;
  return {
    fixedMarkup: parseFloat(query.markup) || parseFloat(query.fixedMarkup) || 0,
    variableMarkup: parseFloat(query.variableMarkup) || 0,
    vat: parseFloat(query.vat) || (query.autoVat === 'true' ? countryConfig.defaultVat : 0),
    includeVat: parseFloat(query.vat) > 0 || query.includeVat === 'true' || query.autoVat === 'true',
    roundTo: parseInt(query.roundTo) || 5
  };
}

function parseIntervalOption(query) {
  const raw = query.interval;
  if (raw === undefined || raw === null || raw === '') return '60M';
  const normalised = String(raw).toUpperCase();
  if (!VALID_INTERVALS.has(normalised)) {
    const err = new Error(`Invalid interval '${raw}'. Valid values: 60M, 15M.`);
    err.statusCode = 400;
    throw err;
  }
  return normalised;
}

function validateCountry(countryCode) {
  if (!countryCode || !COUNTRIES[countryCode.toLowerCase()]) return null;
  return countryCode.toLowerCase();
}

// Group prices into UTC-hourly buckets and return mean priceMwh per bucket.
// UTC grouping is correct across DST: UTC has no DST, and local-hour boundaries align with UTC-hour
// boundaries by an integer offset (incl. during DST transitions).
function aggregateToHourly(prices) {
  const buckets = new Map();
  for (const p of prices) {
    const t = new Date(p.time);
    t.setUTCMinutes(0, 0, 0);
    const key = t.toISOString();
    const b = buckets.get(key) || { time: key, sum: 0, count: 0 };
    b.sum += p.priceMwh;
    b.count += 1;
    buckets.set(key, b);
  }
  return [...buckets.values()]
    .sort((a, b) => new Date(a.time) - new Date(b.time))
    .map(b => ({ time: b.time, priceMwh: b.sum / b.count, price: b.sum / b.count / 1000 }));
}

async function fetchRawPrices(countryCode, dateStart, dateEnd, includeForecast) {
  const country = COUNTRIES[countryCode];
  const upstreamErrors = [];

  if (ENTSOE_API_KEY) {
    try {
      const entsoe = new EntsoeAPI(ENTSOE_API_KEY);
      const prices = await entsoe.getCountryPrices(countryCode, dateStart, dateEnd);
      if (prices.length > 0) return { source: 'entsoe', prices };
      upstreamErrors.push('entsoe: empty response');
    } catch (e) {
      upstreamErrors.push(`entsoe: ${e.message}`);
    }
  }

  // Stekker fallback. Region is swapped per request via constructor in stekker.js (see below);
  // here we just instantiate with the country's region.
  const stekker = new StekkerAPI({ region: country.stekkerRegion });
  const prices = await stekker.getDutchPrices(dateStart, dateEnd, includeForecast, {
    fixedMarkup: 0,
    variableMarkup: 0,
    vat: 0,
    includeVat: false,
    roundTo: 5
  });
  return { source: 'stekker', prices, upstreamErrors: upstreamErrors.length ? upstreamErrors : undefined };
}

async function fetchCountryPrices(countryCode, markupOptions, intervalOptions = {}) {
  const interval = intervalOptions.interval || '60M';
  const now = new Date();
  const key = dailyCacheKey(countryCode, now);

  let entry = __rawCache.get(key);
  if (!entry || entry.refreshAfter <= Date.now()) {
    const { start, end } = canonicalFetchWindow(countryCode, now);
    const data = await fetchRawPrices(countryCode, start, end, false);
    entry = { data, refreshAfter: computeRefreshAfter(countryCode, now) };
    __rawCache.set(key, entry);
  }
  const cached = entry.data;

  // Aggregate (or pass through) before markup so VAT/markup are applied to the displayed cadence.
  const basePrices =
    interval === '60M'
      ? aggregateToHourly(cached.prices)
      : cached.prices.map(p => ({ time: p.time, priceMwh: p.priceMwh, price: p.price }));

  // Reuse Stekker's markup function as a pure utility — it doesn't depend on instance state.
  const applied = new StekkerAPI().applyMarkup(basePrices, markupOptions || {});

  const warnings = [];
  if (cached.source === 'stekker') {
    if (interval === '15M') {
      warnings.push('fallback_source: stekker_quarterly (HH:00 quarters may carry stale hourly clearing prices)');
    } else {
      warnings.push('fallback_source: stekker');
    }
  }

  return {
    prices: applied,
    source: cached.source,
    resolutionMinutes: interval === '60M' ? 60 : 15,
    warnings: warnings.length ? warnings : undefined
  };
}

function enrichPricesWithCountryInfo(prices, countryCode, options = {}) {
  const country = COUNTRIES[countryCode];
  const referenceTime = options.referenceTime ? new Date(options.referenceTime) : null;

  return prices.map((price, index) => {
    const hourTime = new Date(price.time);
    const enriched = {
      ...price,
      localTime: hourTime.toLocaleString(country.locale, {
        timeZone: country.timezone,
        hour: '2-digit',
        minute: '2-digit'
      }),
      hour: hourTime.toLocaleTimeString(country.locale, {
        timeZone: country.timezone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      })
    };

    if (options.includeSpanInfo) {
      enriched.hourFromNow = referenceTime
        ? Math.floor((hourTime.getTime() - referenceTime.getTime()) / 3_600_000)
        : index;
      enriched.dayOfWeek = hourTime.toLocaleDateString('en-US', {
        timeZone: country.timezone,
        weekday: 'long'
      });
      enriched.localTime = hourTime.toLocaleString(country.locale, {
        timeZone: country.timezone,
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit'
      });
    }

    return enriched;
  });
}

function buildCountryResponse(countryCode, data, markupOptions, type, additionalInfo = {}) {
  const country = COUNTRIES[countryCode];
  const { source, resolutionMinutes, warnings, ...rest } = additionalInfo;
  const intervalCount = data.length;
  const totalHours = resolutionMinutes === 15 ? Math.floor(intervalCount / 4) : intervalCount;

  const response = {
    status: 'success',
    country: {
      code: countryCode.toUpperCase(),
      name: country.name,
      currency: country.currency,
      timezone: country.timezone
    },
    data,
    markup: markupOptions,
    fetchedAt: new Date().toISOString(),
    info: {
      type,
      totalIntervals: intervalCount,
      totalHours,
      resolutionMinutes: resolutionMinutes || 60,
      priceUnit: `${country.currency}/kWh`,
      timezone: country.timezone,
      source: source || 'entsoe',
      ...rest
    }
  };

  if (warnings && warnings.length) response.warnings = warnings;
  return response;
}

function getCacheStats() {
  const now = Date.now();
  let size = 0;
  const byCountry = {};
  const bySource = {};
  let nextRefresh = null;
  for (const [key, entry] of __rawCache.entries()) {
    if (entry.refreshAfter <= now) continue;
    size += 1;
    const country = key.split('|')[0];
    byCountry[country] = (byCountry[country] || 0) + 1;
    const src = entry.data?.source || 'unknown';
    bySource[src] = (bySource[src] || 0) + 1;
    if (!nextRefresh || entry.refreshAfter < nextRefresh) nextRefresh = entry.refreshAfter;
  }
  return {
    size,
    strategy: 'daily-key + refresh-after-publish',
    byCountry,
    bySource,
    nextRefresh: nextRefresh ? new Date(nextRefresh).toISOString() : null
  };
}

module.exports = {
  parseMarkupOptions,
  parseIntervalOption,
  validateCountry,
  fetchCountryPrices,
  enrichPricesWithCountryInfo,
  buildCountryResponse,
  aggregateToHourly,
  getCacheStats
};
