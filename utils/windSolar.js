// Opt-in forecast of wind and solar production as a share of demand. It is not a renewable share or a CO2 figure:
// ENTSOE has no day-ahead forecast for hydro, biomass or nuclear. Prices never depend on it: a failure here gives
// null shares and a warning, and the fetch runs alongside the price fetch so it can't add to that wait. A request waits
// briefly, but ENTSOE can take far longer than that, so the fetch carries on and its result serves later requests.
const { EntsoeAPI } = require('../entsoe');
const { fetchCountryPrices, logUpstreamFetch } = require('./helpers');

const ENTSOE_API_KEY = process.env.ENTSOE_API_KEY;
const SOURCE = 'entsoe_wind_solar';
const REQUEST_WAIT_MS = 5000;
const FETCH_TIMEOUT_MS = 30_000;
const CACHE_MS = 60 * 60_000;
const MAX_STALE_MS = 6 * 60 * 60_000;
const FAILURE_RETRY_MS = 5 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const QUARTER_MS = 15 * 60_000;
const UNAVAILABLE_WARNING = 'wind_solar_unavailable: the wind and solar forecast could not be fetched in time';

// countryCode -> { shares: Map of quarter start in epoch ms to percent, or null after a failure, fetchedAt, expiresAt }
const cache = new Map();
// countryCode -> promise of the running fetch, shared by concurrent requests
const inFlight = new Map();

async function fetchShares(countryCode) {
  const dayStart = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  // Covers any country's today and tomorrow. Starting a day early also shows which production types a zone publishes,
  // so a type still missing for tomorrow is noticed.
  const start = new Date(dayStart - DAY_MS);
  const end = new Date(dayStart + 3 * DAY_MS);

  const entsoe = new EntsoeAPI(ENTSOE_API_KEY, { timeout: FETCH_TIMEOUT_MS });
  const [production, demand] = await Promise.all([
    entsoe.getWindSolarForecast(countryCode, start, end),
    entsoe.getLoadForecast(countryCode, start, end)
  ]);

  const shares = new Map();
  for (const [time, megawatts] of production) {
    const load = demand.get(time);
    if (load > 0) shares.set(time, (megawatts / load) * 100);
  }
  return shares;
}

async function refreshShares(countryCode) {
  const started = Date.now();
  try {
    const shares = await fetchShares(countryCode);
    logUpstreamFetch(countryCode, SOURCE, undefined, Date.now() - started);
    cache.set(countryCode, { shares, fetchedAt: Date.now(), expiresAt: Date.now() + CACHE_MS });
    return shares;
  } catch (error) {
    logUpstreamFetch(countryCode, SOURCE, [error.message], Date.now() - started);
    cache.set(countryCode, { shares: null, fetchedAt: Date.now(), expiresAt: Date.now() + FAILURE_RETRY_MS });
    return null;
  } finally {
    inFlight.delete(countryCode);
  }
}

function withinRequestWait(promise) {
  let timer;
  const gaveUp = new Promise(resolve => {
    timer = setTimeout(resolve, REQUEST_WAIT_MS, null);
  });
  return Promise.race([promise, gaveUp]).finally(() => clearTimeout(timer));
}

// Never rejects. Resolves to null when the forecast is unavailable, or isn't ready within the request's wait.
async function getShares(countryCode) {
  if (!ENTSOE_API_KEY) return null;

  const now = Date.now();
  const cached = cache.get(countryCode);
  if (cached && cached.expiresAt > now) return cached.shares;

  if (!inFlight.has(countryCode)) inFlight.set(countryCode, refreshShares(countryCode));
  // Clients polling less often than the cache lasts, such as TRMNL, would otherwise wait on every poll.
  if (cached?.shares && now - cached.fetchedAt < MAX_STALE_MS) return cached.shares;
  return withinRequestWait(inFlight.get(countryCode));
}

// The mean over the price's whole interval, so null if any quarter of it has no forecast.
function shareForInterval(shares, time, resolutionMinutes) {
  const start = new Date(time).getTime();
  const quarters = Math.round(resolutionMinutes / 15);
  let sum = 0;
  for (let i = 0; i < quarters; i += 1) {
    const share = shares.get(start + i * QUARTER_MS);
    if (share === undefined) return null;
    sum += share;
  }
  return Math.round((sum / quarters) * 10) / 10;
}

async function fetchPricesWithWindSolar(countryCode, markupOptions, intervalOptions, includeWindSolar) {
  if (!includeWindSolar) return fetchCountryPrices(countryCode, markupOptions, intervalOptions);

  const [result, shares] = await Promise.all([
    fetchCountryPrices(countryCode, markupOptions, intervalOptions),
    getShares(countryCode)
  ]);

  return {
    ...result,
    prices: result.prices.map(price => ({
      ...price,
      windSolarShare: shares ? shareForInterval(shares, price.time, result.resolutionMinutes) : null
    })),
    warnings: shares ? result.warnings : [...(result.warnings || []), UNAVAILABLE_WARNING]
  };
}

module.exports = { fetchPricesWithWindSolar };
