// routes/providers.js - Energy provider preset routes
const express = require('express');
const router = express.Router();

const { fetchCountryPrices, buildCountryResponse } = require('../utils/helpers');

// Next Energy preset (Netherlands)
router.get('/next-energy', async (req, res) => {
  try {
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const prices = await fetchCountryPrices('nl', today, tomorrow, false, {
      fixedMarkup: 0.024,
      vat: 0.21 // 21% VAT as decimal
    });

    res.json({
      status: 'success',
      provider: 'Next Energy',
      country: { code: 'NL', name: 'Netherlands', currency: 'EUR' },
      data: prices,
      markup: {
        fixed: 0.024,
        vat: 0.21,
        vatPercent: '21%',
        description: 'Next Energy standard markup with Dutch VAT'
      },
      fetchedAt: new Date().toISOString()
    });

  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// Generic provider endpoint for any country
router.get('/:provider/:country', async (req, res) => {
  try {
    const { provider, country } = req.params;
    
    // Define provider presets
    const PROVIDER_PRESETS = {
      'next-energy': {
        name: 'Next Energy',
        countries: ['nl'],
        markup: { fixedMarkup: 0.024, vat: 0.21 }
      },
      'vattenfall': {
        name: 'Vattenfall',
        countries: ['nl', 'de', 'se'],
        markup: { fixedMarkup: 0.030, vat: 'auto' }
      },
      'eneco': {
        name: 'Eneco',
        countries: ['nl', 'be'],
        markup: { fixedMarkup: 0.028, vat: 'auto' }
      }
    };

    const providerConfig = PROVIDER_PRESETS[provider.toLowerCase()];
    
    if (!providerConfig) {
      return res.status(404).json({
        status: 'error',
        message: `Provider '${provider}' not found. Available providers: ${Object.keys(PROVIDER_PRESETS).join(', ')}`
      });
    }

    if (!providerConfig.countries.includes(country.toLowerCase())) {
      return res.status(400).json({
        status: 'error',
        message: `Provider '${provider}' not available in ${country.toUpperCase()}. Available countries: ${providerConfig.countries.map(c => c.toUpperCase()).join(', ')}`
      });
    }

    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Apply auto VAT if specified
    let markupOptions = { ...providerConfig.markup };
    if (markupOptions.vat === 'auto') {
      const { COUNTRIES } = require('../config/countries');
      markupOptions.vat = COUNTRIES[country.toLowerCase()].defaultVat;
    }

    const prices = await fetchCountryPrices(country.toLowerCase(), today, tomorrow, false, markupOptions);

    const response = {
      status: 'success',
      provider: providerConfig.name,
      ...buildCountryResponse(country.toLowerCase(), prices, markupOptions, 'provider-preset')
    };

    res.json(response);

  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// List all available providers
router.get('/', (req, res) => {
  const PROVIDER_PRESETS = {
    'next-energy': {
      name: 'Next Energy',
      countries: ['NL'],
      markup: { fixed: '€0.024/kWh', vat: '21%' },
      endpoint: '/api/providers/next-energy'
    },
    'vattenfall': {
      name: 'Vattenfall',
      countries: ['NL', 'DE', 'SE'],
      markup: { fixed: '€0.030/kWh', vat: 'auto' },
      endpoint: '/api/providers/vattenfall/{country}'
    },
    'eneco': {
      name: 'Eneco',
      countries: ['NL', 'BE'],
      markup: { fixed: '€0.028/kWh', vat: 'auto' },
      endpoint: '/api/providers/eneco/{country}'
    }
  };

  res.json({
    status: 'success',
    data: Object.entries(PROVIDER_PRESETS).map(([key, config]) => ({
      id: key,
      ...config
    })),
    total: Object.keys(PROVIDER_PRESETS).length
  });
});

module.exports = router;