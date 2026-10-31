// routes/providers.js - Energy provider preset routes
const express = require('express');
const router = express.Router();
const { fromZonedTime, toZonedTime } = require('date-fns-tz');
const { startOfDay, endOfDay, addDays } = require('date-fns');

const { fetchCountryPrices, buildCountryResponse, parseIntervalOption } = require('../utils/helpers');

const PROVIDER_PRESETS = {
  'next-energy': {
    name: 'Next Energy',
    countries: ['nl'],
    markup: { fixedMarkup: 0.024, vat: 0.21 }
  },
  vattenfall: {
    name: 'Vattenfall',
    countries: ['nl', 'de', 'se'],
    markup: { fixedMarkup: 0.03, vat: 'auto' }
  },
  eneco: {
    name: 'Eneco',
    countries: ['nl', 'be'],
    markup: { fixedMarkup: 0.028, vat: 'auto' }
  }
};

// Next Energy preset (Netherlands)
router.get('/next-energy', async (req, res, next) => {
  try {
    const { COUNTRIES } = require('../config/countries');
    const country = COUNTRIES.nl;
    const now = new Date();

    // Get today and tomorrow in Netherlands timezone using date-fns-tz
    // Convert current UTC time to Netherlands timezone
    const nowInTargetTz = toZonedTime(now, country.timezone);

    // Get start of today and end of tomorrow in target timezone
    const todayStartInTargetTz = startOfDay(nowInTargetTz);
    const tomorrowEndInTargetTz = endOfDay(addDays(nowInTargetTz, 1));

    // Convert back to UTC for API processing
    const today = fromZonedTime(todayStartInTargetTz, country.timezone);
    const tomorrow = fromZonedTime(tomorrowEndInTargetTz, country.timezone);

    const interval = parseIntervalOption(req.query);

    const { markup } = PROVIDER_PRESETS['next-energy'];
    const result = await fetchCountryPrices('nl', markup, { interval });

    const windowPrices = result.prices.filter(p => {
      const t = new Date(p.time);
      return t >= today && t <= tomorrow;
    });

    res.json({
      status: 'success',
      provider: 'Next Energy',
      country: { code: 'NL', name: 'Netherlands', currency: 'EUR' },
      data: windowPrices,
      markup: {
        fixed: markup.fixedMarkup,
        vat: markup.vat,
        vatPercent: `${markup.vat * 100}%`,
        description: 'Next Energy standard markup with Dutch VAT'
      },
      info: {
        source: result.source,
        resolutionMinutes: result.resolutionMinutes
      },
      ...(result.warnings ? { warnings: result.warnings } : {}),
      fetchedAt: new Date().toISOString()
    });
  } catch (error) {
    next(error);
  }
});

// Generic provider endpoint for any country
router.get('/:provider/:country', async (req, res, next) => {
  try {
    const { provider, country } = req.params;

    const providerKey = provider.toLowerCase();
    const providerConfig = Object.hasOwn(PROVIDER_PRESETS, providerKey) ? PROVIDER_PRESETS[providerKey] : null;

    if (!providerConfig) {
      return res.status(404).json({
        status: 'error',
        message: `Provider '${provider}' not found. Available providers: ${Object.keys(PROVIDER_PRESETS).join(', ')}`
      });
    }

    if (!providerConfig.countries.includes(country.toLowerCase())) {
      return res.status(400).json({
        status: 'error',
        message:
          `Provider '${provider}' not available in ${country.toUpperCase()}. ` +
          `Available countries: ${providerConfig.countries.map(c => c.toUpperCase()).join(', ')}`
      });
    }

    // Get today and tomorrow in the target country's timezone
    const { COUNTRIES } = require('../config/countries');
    const countryConfig = COUNTRIES[country.toLowerCase()];
    const now = new Date();

    // Get today and tomorrow in target country timezone using date-fns-tz
    // Convert current UTC time to target timezone
    const nowInTargetTz = toZonedTime(now, countryConfig.timezone);

    // Get start of today and end of tomorrow in target timezone
    const todayStartInTargetTz = startOfDay(nowInTargetTz);
    const tomorrowEndInTargetTz = endOfDay(addDays(nowInTargetTz, 1));

    // Convert back to UTC for API processing
    const today = fromZonedTime(todayStartInTargetTz, countryConfig.timezone);
    const tomorrow = fromZonedTime(tomorrowEndInTargetTz, countryConfig.timezone);

    // Apply auto VAT if specified
    const markupOptions = { ...providerConfig.markup };
    if (markupOptions.vat === 'auto') {
      markupOptions.vat = countryConfig.defaultVat;
    }

    const interval = parseIntervalOption(req.query);

    const result = await fetchCountryPrices(country.toLowerCase(), markupOptions, { interval });

    const windowPrices = result.prices.filter(p => {
      const t = new Date(p.time);
      return t >= today && t <= tomorrow;
    });

    const response = {
      status: 'success',
      provider: providerConfig.name,
      ...buildCountryResponse(country.toLowerCase(), windowPrices, markupOptions, 'provider-preset', {
        source: result.source,
        resolutionMinutes: result.resolutionMinutes,
        warnings: result.warnings
      })
    };

    res.json(response);
  } catch (error) {
    next(error);
  }
});

// List all available providers
router.get('/', (req, res) => {
  const providers = Object.entries(PROVIDER_PRESETS).map(([id, { name, countries, markup }]) => ({
    id,
    name,
    countries: countries.map(country => country.toUpperCase()),
    markup: {
      fixed: `€${markup.fixedMarkup.toFixed(3)}/kWh`,
      vat: markup.vat === 'auto' ? 'auto' : `${markup.vat * 100}%`
    },
    endpoint: id === 'next-energy' ? '/api/providers/next-energy' : `/api/providers/${id}/{country}`
  }));

  res.json({ status: 'success', data: providers, total: providers.length });
});

module.exports = router;
