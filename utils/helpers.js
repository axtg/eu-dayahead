const { COUNTRIES } = require('../config/countries');
const { StekkerAPI } = require('../stekker');

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

// Helper function to get country-specific price fetcher
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

  return await countryStekker.getDutchPrices(dateStart, dateEnd, includeForecast, markupOptions);
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

module.exports = {
  parseMarkupOptions,
  validateCountry,
  fetchCountryPrices,
  enrichPricesWithCountryInfo,
  buildCountryResponse
};
