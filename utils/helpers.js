const { fromZonedTime, toZonedTime } = require('date-fns-tz');
const { startOfDay } = require('date-fns');

const { COUNTRIES } = require('../config/countries');
const { StekkerAPI } = require('../stekker');
const { EntsoeAPI } = require('../entsoe');
const { sendToLogtail } = require('../middleware/logging');

const ENTSOE_API_KEY = process.env.ENTSOE_API_KEY;
const VALID_INTERVALS = new Set(['60M', '15M']);
const NUMBER_FORMAT = /^[-+]?(\d+(\.\d*)?|\.\d+)(e[-+]?\d+)?$/i;
const MAX_FIXED_MARKUP = 10; // EUR/kWh

// ENTSOE day-ahead auction results publish around 14:00 CET; pad to 14:30.
// Day X+2 prices land in the afternoon of day X, so an entry created in the
// morning needs to refresh after this boundary to pick them up.
const ENTSOE_PUBLISH_HOUR_CET = 14;
const ENTSOE_PUBLISH_MINUTE_CET = 30;
const ENTSOE_PUBLISH_TZ = 'Europe/Brussels';

const FALLBACK_RETRY_MS = 5 * 60_000; // Fallback data is replaced by ENTSOE data as soon as it recovers
const MISSING_PRICES_RETRY_MS = 15 * 60_000; // Prices can arrive after the publish boundary
const FAILURE_RETRY_MS = 60_000; // Don't call failing upstreams on every request

// countryCode -> { fetchedAt, refreshAfter, refreshFailed, data: { source, prices, upstreamErrors? } }
const __rawCache = new Map();
// countryCode -> promise of the running upstream fetch, shared by concurrent requests
const __inFlight = new Map();
// countryCode -> { error, retryAfter }, for countries with no cached prices covering today
const __fetchFailures = new Map();

function localDayStart(countryCode, now, dayOffset) {
  const tz = COUNTRIES[countryCode].timezone;
  const dayStartInTz = startOfDay(toZonedTime(now, tz));
  dayStartInTz.setDate(dayStartInTz.getDate() + dayOffset);
  return fromZonedTime(dayStartInTz, tz).getTime();
}

// True if prices run through to the last hour of the given local day
function coversLocalDay(prices, countryCode, now, dayOffset) {
  if (prices.length === 0) return false;
  const lastHourStart = localDayStart(countryCode, now, dayOffset + 1) - 3_600_000;
  return new Date(prices[prices.length - 1].time).getTime() >= lastHourStart;
}

function hasPricesForToday(prices, countryCode, now) {
  const start = localDayStart(countryCode, now, 0);
  const end = localDayStart(countryCode, now, 1);
  return prices.some(price => {
    const time = new Date(price.time).getTime();
    return time >= start && time < end;
  });
}

function lastPriceTime(prices) {
  return new Date(prices[prices.length - 1].time).getTime();
}

// Retries stop at local midnight, when an entry without the new day stops being usable.
function retryAt(countryCode, now, delayMs) {
  return Math.min(now.getTime() + delayMs, localDayStart(countryCode, now, 1));
}

// Single canonical upstream window per country per day, wide enough to cover
// /today, /next24h, and /next/N (N≤48). All endpoints filter the result
// themselves; this is just the raw fetch boundary.
function canonicalFetchWindow(countryCode, now) {
  return { start: new Date(localDayStart(countryCode, now, -1)), end: new Date(localDayStart(countryCode, now, 3)) };
}

function publishBoundary(now) {
  const cetPublishToday = new Date(toZonedTime(now, ENTSOE_PUBLISH_TZ));
  cetPublishToday.setHours(ENTSOE_PUBLISH_HOUR_CET, ENTSOE_PUBLISH_MINUTE_CET, 0, 0);
  return fromZonedTime(cetPublishToday, ENTSOE_PUBLISH_TZ).getTime();
}

// Fallback data: retry ENTSOE soon. Missing today, or the next day after 14:30 CET: retry
// soon. Otherwise refresh at 14:30 CET (to pick up the next auction) or, once past it, at
// midnight in the country's timezone.
function computeRefreshAfter(countryCode, now, data) {
  if (ENTSOE_API_KEY && data.source !== 'entsoe') return retryAt(countryCode, now, FALLBACK_RETRY_MS);

  const midnight = localDayStart(countryCode, now, 1);
  const retrySoon = retryAt(countryCode, now, MISSING_PRICES_RETRY_MS);
  if (!coversLocalDay(data.prices, countryCode, now, 0)) return retrySoon;

  const publishUtc = publishBoundary(now);
  if (now.getTime() < publishUtc) return publishUtc;

  return coversLocalDay(data.prices, countryCode, now, 1) ? midnight : retrySoon;
}

// An expired entry can only stand in for a refresh if nothing newer should exist: it has today's
// prices, and it's from after today's publication, or that hasn't happened yet. If a refresh just
// failed, there's nothing newer to wait for either, and the response carries a warning.
function canServeWhileRefreshing(entry, countryCode, now) {
  if (!coversLocalDay(entry.data.prices, countryCode, now, 0)) return false;
  const publishUtc = publishBoundary(now);
  return entry.refreshFailed || now.getTime() < publishUtc || entry.fetchedAt >= publishUtc;
}

// Prices that are still usable are only replaced by a result reaching as far ahead. A fallback
// result has to reach further than ENTSOE prices to replace them.
function shouldKeepPrevious(previous, data, countryCode, now) {
  if (!coversLocalDay(previous.data.prices, countryCode, now, 0)) return false;
  const reach = lastPriceTime(data.prices) - lastPriceTime(previous.data.prices);
  const fallbackOverEntsoe = data.source !== 'entsoe' && previous.data.source === 'entsoe';
  return fallbackOverEntsoe ? reach <= 0 : reach < 0;
}

function invalidParam(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

// Repeated parameters arrive as arrays and fail the type check. Limits keep prices finite and
// catch unit mix-ups, such as vat=21 or a markup in cents.
function parseNumberParam(query, name, min, max, hint = '') {
  const raw = query[name];
  if (raw === undefined || raw === '') return undefined;
  const value = typeof raw === 'string' && NUMBER_FORMAT.test(raw) ? Number(raw) : NaN;
  if (!(value >= min && value <= max)) {
    throw invalidParam(`Invalid ${name}. Use a number from ${min} to ${max}${hint}.`);
  }
  return value;
}

function parseBooleanParam(query, name) {
  const raw = query[name];
  if (raw === undefined || raw === '') return false;
  const normalised = typeof raw === 'string' ? raw.toLowerCase() : '';
  if (normalised !== 'true' && normalised !== 'false') {
    throw invalidParam(`Invalid ${name}. Use true or false.`);
  }
  return normalised === 'true';
}

// An explicit vat wins, including 0. autoVat and includeVat both mean the country's rate.
function parseVat(query, countryConfig) {
  const autoVat = parseBooleanParam(query, 'autoVat');
  const includeVat = parseBooleanParam(query, 'includeVat');
  if (query.vat === 'auto') return countryConfig.defaultVat;
  const vat = parseNumberParam(query, 'vat', 0, 1, ' (0.21 means 21%), or auto');
  if (vat !== undefined) return vat;
  return autoVat || includeVat ? countryConfig.defaultVat : 0;
}

function parseRoundTo(query) {
  const roundTo = parseNumberParam(query, 'roundTo', 0, 10);
  if (roundTo !== undefined && !Number.isInteger(roundTo)) {
    throw invalidParam('Invalid roundTo. Use a whole number from 0 to 10.');
  }
  return roundTo ?? 5;
}

function parseMarkupOptions(query, country) {
  const countryConfig = COUNTRIES[country] || COUNTRIES.nl;
  const vat = parseVat(query, countryConfig);
  return {
    fixedMarkup:
      parseNumberParam(query, 'markup', -MAX_FIXED_MARKUP, MAX_FIXED_MARKUP, ' (EUR/kWh)') ??
      parseNumberParam(query, 'fixedMarkup', -MAX_FIXED_MARKUP, MAX_FIXED_MARKUP, ' (EUR/kWh)') ??
      0,
    variableMarkup: parseNumberParam(query, 'variableMarkup', -100, 1000, ' (percent)') ?? 0,
    vat,
    includeVat: vat > 0,
    roundTo: parseRoundTo(query)
  };
}

function parseIntervalOption(query) {
  const raw = query.interval;
  if (raw === undefined || raw === null || raw === '') return '60M';
  const normalised = String(raw).toUpperCase();
  if (!VALID_INTERVALS.has(normalised)) {
    throw invalidParam(`Invalid interval '${raw}'. Valid values: 60M, 15M.`);
  }
  return normalised;
}

function validateCountry(countryCode) {
  if (!countryCode || !Object.hasOwn(COUNTRIES, countryCode.toLowerCase())) return null;
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

// Smallest gap between consecutive prices. Some zones (e.g. CH) only publish hourly data.
function detectResolutionMinutes(prices) {
  let smallestGap = Infinity;
  for (let i = 1; i < prices.length; i += 1) {
    smallestGap = Math.min(smallestGap, new Date(prices[i].time) - new Date(prices[i - 1].time));
  }
  return Number.isFinite(smallestGap) ? smallestGap / 60_000 : 60;
}

async function fetchRawPrices(countryCode, dateStart, dateEnd, includeForecast) {
  const country = COUNTRIES[countryCode];
  const upstreamErrors = [];

  const now = new Date();
  let partialEntsoePrices = null;

  if (ENTSOE_API_KEY) {
    try {
      const entsoe = new EntsoeAPI(ENTSOE_API_KEY);
      const prices = await entsoe.getCountryPrices(countryCode, dateStart, dateEnd);
      if (coversLocalDay(prices, countryCode, now, 0)) return { source: 'entsoe', prices };
      if (hasPricesForToday(prices, countryCode, now)) {
        partialEntsoePrices = prices;
        upstreamErrors.push('entsoe: prices missing for part of today');
      } else {
        upstreamErrors.push('entsoe: no prices for today');
      }
    } catch (e) {
      upstreamErrors.push(`entsoe: ${e.message}`);
    }
  }

  // Stekker fallback. Region is swapped per request via constructor in stekker.js (see below);
  // here we just instantiate with the country's region.
  try {
    const stekker = new StekkerAPI({ region: country.stekkerRegion });
    const prices = await stekker.getDutchPrices(dateStart, dateEnd, includeForecast, {
      fixedMarkup: 0,
      variableMarkup: 0,
      vat: 0,
      includeVat: false,
      roundTo: 5
    });
    if (!hasPricesForToday(prices, countryCode, now)) throw new Error('Stekker API Error: no prices for today');
    if (partialEntsoePrices && lastPriceTime(prices) <= lastPriceTime(partialEntsoePrices)) {
      return { source: 'entsoe', prices: partialEntsoePrices, upstreamErrors };
    }
    return { source: 'stekker', prices, upstreamErrors: upstreamErrors.length ? upstreamErrors : undefined };
  } catch (e) {
    upstreamErrors.push(`stekker: ${e.message}`);
    if (partialEntsoePrices) return { source: 'entsoe', prices: partialEntsoePrices, upstreamErrors };
    e.upstreamErrors = upstreamErrors;
    throw e;
  }
}

const DISCARDED_NOTE = ' (result discarded, cached prices kept)';

function logUpstreamFetch(countryCode, source, upstreamErrors, durationMs, discarded = false) {
  if (upstreamErrors) console.error(`Upstream errors for ${countryCode}:`, upstreamErrors.join('; '));

  sendToLogtail({
    dt: new Date().toISOString(),
    level: upstreamErrors ? 'error' : 'info',
    message: `Upstream fetch: ${countryCode} from ${source || 'none'}${discarded ? DISCARDED_NOTE : ''}`,
    country: countryCode,
    source,
    upstreamErrors,
    durationMs,
    service: 'eu-dayahead-api',
    environment: process.env.NODE_ENV || 'development'
  });
}

function runUpstreamFetch(countryCode) {
  const now = new Date();
  const { start, end } = canonicalFetchWindow(countryCode, now);

  return fetchRawPrices(countryCode, start, end, false)
    .then(data => {
      __fetchFailures.delete(countryCode);

      const previous = __rawCache.get(countryCode);
      const keepPrevious = previous && shouldKeepPrevious(previous, data, countryCode, now);
      logUpstreamFetch(countryCode, data.source, data.upstreamErrors, Date.now() - now.getTime(), keepPrevious);

      if (keepPrevious) {
        const bothEntsoe = data.source === 'entsoe' && previous.data.source === 'entsoe';
        const retryDelay = bothEntsoe ? MISSING_PRICES_RETRY_MS : FALLBACK_RETRY_MS;
        // A healthy ENTSOE response that doesn't reach as far as fallback prices isn't a failure.
        // Those prices already carry a fallback warning.
        const healthyOverFallback = data.source === 'entsoe' && !bothEntsoe && !data.upstreamErrors;
        previous.refreshFailed = !healthyOverFallback;
        previous.refreshAfter = retryAt(countryCode, now, retryDelay);
        return previous;
      }

      const entry = {
        data,
        fetchedAt: now.getTime(),
        refreshFailed: false,
        refreshAfter: computeRefreshAfter(countryCode, now, data)
      };
      __rawCache.set(countryCode, entry);
      return entry;
    })
    .catch(error => {
      logUpstreamFetch(countryCode, null, error.upstreamErrors, Date.now() - now.getTime());
      const retryAfter = retryAt(countryCode, new Date(), FAILURE_RETRY_MS);

      const previous = __rawCache.get(countryCode);
      if (previous && hasPricesForToday(previous.data.prices, countryCode, new Date())) {
        previous.refreshFailed = true;
        previous.refreshAfter = retryAfter;
        return previous;
      }

      __fetchFailures.set(countryCode, { error, retryAfter });
      throw error;
    })
    .finally(() => __inFlight.delete(countryCode));
}

function refreshCountry(countryCode) {
  if (!__inFlight.has(countryCode)) __inFlight.set(countryCode, runUpstreamFetch(countryCode));
  return __inFlight.get(countryCode);
}

async function getCacheEntry(countryCode) {
  const entry = __rawCache.get(countryCode);
  if (entry && entry.refreshAfter > Date.now()) return entry;

  if (entry && canServeWhileRefreshing(entry, countryCode, new Date())) {
    // A failure is already logged by the fetch, and this visitor has their prices either way.
    refreshCountry(countryCode).catch(() => {});
    return entry;
  }

  const failure = __fetchFailures.get(countryCode);
  if (failure && failure.retryAfter > Date.now()) throw failure.error;

  return refreshCountry(countryCode);
}

async function fetchCountryPrices(countryCode, markupOptions, intervalOptions = {}) {
  const interval = intervalOptions.interval || '60M';

  const entry = await getCacheEntry(countryCode);
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
  if (entry.refreshFailed) warnings.push('stale_data: upstream refresh failed');
  if (!coversLocalDay(cached.prices, countryCode, new Date(), 0)) {
    warnings.push('incomplete_data: prices missing for part of today');
  }

  return {
    prices: applied,
    source: cached.source,
    resolutionMinutes: interval === '60M' ? 60 : detectResolutionMinutes(basePrices),
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
  const totalHours = Math.floor((intervalCount * (resolutionMinutes || 60)) / 60);

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
  const staleCountries = [];
  for (const [key, entry] of __rawCache.entries()) {
    if (entry.refreshFailed) staleCountries.push(key);
    if (entry.refreshAfter <= now) continue;
    size += 1;
    byCountry[key] = (byCountry[key] || 0) + 1;
    const src = entry.data?.source || 'unknown';
    bySource[src] = (bySource[src] || 0) + 1;
    if (!nextRefresh || entry.refreshAfter < nextRefresh) nextRefresh = entry.refreshAfter;
  }
  return {
    size,
    strategy: 'per-country + refresh-after-publish',
    byCountry,
    bySource,
    staleCountries,
    failedCountries: [...__fetchFailures.keys()],
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
