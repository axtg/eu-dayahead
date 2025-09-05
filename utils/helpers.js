const { COUNTRIES } = require('../config/countries');
const { StekkerAPI } = require('../stekker');

// In-memory cache for upstream raw prices (per country/time range)
const CACHE_TTL_MS = parseInt(process.env.CACHE_TIMEOUT_MS || '3600000', 10); // default 1 hour
const __rawCache = new Map(); // key -> { expiresAt, data }

function cacheKey(countryCode, start, end, includeForecast) {
  const norm = (d) => {
    const x = new Date(d);
    x.setMinutes(0, 0, 0);
    return x.toISOString();
  };
  return `${countryCode}|${norm(start)}|${norm(end)}|${includeForecast ? '1' : '0'}`;
}

function getCachedRaw(countryCode, start, end, includeForecast) {
  const key = cacheKey(countryCode, start, end, includeForecast);
  const entry = __rawCache.get(key);
  if (entry && entry.expiresAt > Date.now()) {
    return entry.data;
  }
  return null;
}

function setCachedRaw(countryCode, start, end, includeForecast, data) {
  const key = cacheKey(countryCode, start, end, includeForecast);
  __rawCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, data });
}

// Helper function to parse markup options from query parameters
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

// Helper function to validate country code
function validateCountry(countryCode) {
  if (!countryCode || !COUNTRIES[countryCode.toLowerCase()]) {
    return null;
  }
  return countryCode.toLowerCase();
}

// Helper function to get country-specific price fetcher (with raw cache)
async function fetchCountryPrices(countryCode, dateStart, dateEnd, includeForecast, markupOptions) {
  const country = COUNTRIES[countryCode];

  // Create a country-specific Stekker instance
  const countryStekker = new StekkerAPI();

  // Monkey-patch the region for this request
  const originalMakeRequest = countryStekker.makeRequest;
  countryStekker.makeRequest = function (path) {
    // Replace region=NL with the country's region
    const modifiedPath = path.replace('region=NL', `region=${country.stekkerRegion}`);
    return originalMakeRequest.call(this, modifiedPath);
  };

  // Try cache: store raw upstream prices (no markup), then apply markup per request
  let raw = getCachedRaw(countryCode, dateStart, dateEnd, includeForecast);
  if (!raw) {
    // Fetch without markup to maximize cache reusability
    raw = await countryStekker.getDutchPrices(dateStart, dateEnd, includeForecast, { fixedMarkup: 0, variableMarkup: 0, vat: 0, includeVat: false, roundTo: 5 });
    setCachedRaw(countryCode, dateStart, dateEnd, includeForecast, raw);
  }

  // Apply markup per request on top of raw
  const applied = countryStekker.applyMarkup(raw, markupOptions || {});
  return applied;
}

// Helper function to enrich prices with country-specific formatting
function enrichPricesWithCountryInfo(prices, countryCode, options = {}) {
  const country = COUNTRIES[countryCode];

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

    // Add additional info for spanning time periods
    if (options.includeSpanInfo) {
      enriched.hourFromNow = index;
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

// Helper function to build country response info
function buildCountryResponse(countryCode, data, markupOptions, type, additionalInfo = {}) {
  const country = COUNTRIES[countryCode];

  return {
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
      totalHours: data.length,
      priceUnit: `${country.currency}/kWh`,
      timezone: country.timezone,
      ...additionalInfo
    }
  };
}

function getCacheStats() {
  const now = Date.now();
  let size = 0;
  const byCountry = {};
  let earliestExpiry = null;
  for (const [key, entry] of __rawCache.entries()) {
    if (entry.expiresAt <= now) continue; // consider expired entries as absent
    size += 1;
    const country = key.split('|')[0];
    byCountry[country] = (byCountry[country] || 0) + 1;
    if (!earliestExpiry || entry.expiresAt < earliestExpiry) earliestExpiry = entry.expiresAt;
  }
  return {
    size,
    ttlMs: CACHE_TTL_MS,
    byCountry,
    earliestExpiry: earliestExpiry ? new Date(earliestExpiry).toISOString() : null
  };
}

module.exports = {
  parseMarkupOptions,
  validateCountry,
  fetchCountryPrices,
  enrichPricesWithCountryInfo,
  buildCountryResponse,
  getCacheStats
};
