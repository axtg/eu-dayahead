// Stekker.app API for Dutch Energy Prices
// Based on the stekker.js implementation from powerhour

const https = require('https');

class StekkerAPI {
  constructor() {
    this.host = 'stekker.app';
    this.port = 443;
    this.timeout = 30000;
    this.biddingZone = '10YNL----------L'; // Netherlands
  }

  async getDutchPrices(dateStart, dateEnd, includeForecast = false, options = {}) {
    try {
      const today = new Date();
      const tomorrow = new Date(today);
      tomorrow.setDate(today.getDate() + 1);

      const start = dateStart || today;
      const end = dateEnd || tomorrow;

      start.setMinutes(0, 0, 0);
      end.setDate(end.getDate() + 1); // Include full end day

      const startDate = start.toISOString();
      const endDate = end.toISOString();

      // Construct API path
      let path = '/epex-forecast?advanced_view=&region=NL&unit=MWh';
      if (!includeForecast) {
        path += `&filter_from=${startDate}&filter_to=${endDate}`;
      }

      const response = await this.makeRequest(path);
      const prices = this.parseResponse(response, start, end, includeForecast);

      // Apply markup if provided
      return this.applyMarkup(prices, options);
    } catch (error) {
      throw new Error(`Stekker API Error: ${error.message}`);
    }
  }

  applyMarkup(prices, options = {}) {
    const {
      fixedMarkup = 0, // Fixed markup in EUR/kWh (e.g., 0.024 for Next Energy)
      variableMarkup = 0, // Variable markup in % (e.g., 5 for 5%)
      vat = 0, // VAT as decimal (e.g., 0.21 for 21%)
      includeVat = false, // Backward compatibility
      roundTo = 5 // Round to 5 decimal places
    } = options;

    // Determine VAT rate - use vat parameter if provided, otherwise check includeVat
    const vatRate = vat > 0 ? vat : includeVat ? 0.21 : 0;

    return prices.map(hour => {
      let finalPrice = hour.price;

      // Apply variable markup (percentage)
      if (variableMarkup !== 0) {
        finalPrice *= 1 + variableMarkup / 100;
      }

      // Apply fixed markup (EUR/kWh)
      if (fixedMarkup !== 0) {
        finalPrice += fixedMarkup;
      }

      // Apply VAT if specified
      if (vatRate > 0) {
        finalPrice *= 1 + vatRate;
      }

      // Round to specified decimal places
      finalPrice = Math.round(finalPrice * Math.pow(10, roundTo)) / Math.pow(10, roundTo);

      return {
        ...hour,
        price: finalPrice,
        markup: {
          fixed: fixedMarkup,
          variable: variableMarkup,
          vat: vatRate,
          vatPercent: `${Math.round(vatRate * 100)}%`,
          originalPrice: hour.price
        }
      };
    });
  }

  async makeRequest(path) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.host,
        port: this.port,
        path: path,
        method: 'GET',
        timeout: this.timeout
      };

      const req = https.request(options, res => {
        let body = '';
        res.on('data', chunk => (body += chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${body}`));
            return;
          }
          resolve(body);
        });
      });

      req.on('error', reject);
      req.on('timeout', () => reject(new Error('Request timeout')));
      req.end();
    });
  }

  parseResponse(htmlResponse, start, end, includeForecast) {
    if (!htmlResponse.includes('price')) {
      throw new Error('No price data found in response');
    }

    // Extract JSON data from the data-epex-forecast-graph-data-value attribute
    const dataAttributeMatch = htmlResponse.match(/data-epex-forecast-graph-data-value="([^"]+)"/);

    if (!dataAttributeMatch) {
      throw new Error('Could not find price data attribute in HTML');
    }

    // Decode HTML entities and parse JSON
    const decodedData = dataAttributeMatch[1]
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');

    let plotlyData;
    try {
      plotlyData = JSON.parse(decodedData);
    } catch (error) {
      throw new Error('Could not parse JSON data from HTML');
    }

    // Find the Market price data (usually the 4th object with name "Market price")
    const marketPriceData = plotlyData.find(
      series => series.name === 'Market price' || (series.name && series.name.includes('Market'))
    );

    if (!marketPriceData || !marketPriceData.x || !marketPriceData.y) {
      throw new Error('Could not find market price data in response');
    }

    const times = marketPriceData.x;
    const prices = marketPriceData.y;

    if (times.length !== prices.length) {
      throw new Error('Times and prices arrays have different lengths');
    }

    let processedPrices = times
      .map((time, idx) => ({
        time: new Date(time).toISOString(),
        priceMwh: prices[idx], // EUR/MWh (raw market price)
        price: prices[idx] ? prices[idx] / 1000 : null // EUR/kWh (consumer-friendly)
      }))
      .filter(hour => hour.price !== null)
      .sort((a, b) => new Date(a.time) - new Date(b.time));

    if (!includeForecast && start && end) {
      // Filter to requested date range
      processedPrices = processedPrices
        .filter(hourInfo => new Date(hourInfo.time) >= start)
        .filter(hourInfo => new Date(hourInfo.time) < end);
    }

    return processedPrices;
  }
}

// Usage Examples
async function getDutchEnergyPrices() {
  const stekker = new StekkerAPI();

  try {
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Get raw market prices (EUR/kWh)
    const rawPrices = await stekker.getDutchPrices(today, tomorrow, false);
    console.log('Raw Market Prices (EUR/kWh):', JSON.stringify(rawPrices.slice(0, 3), null, 2));

    // Get prices with Next Energy markup (0.024 EUR/kWh + 21% VAT)
    const nextEnergyPrices = await stekker.getDutchPrices(today, tomorrow, false, {
      fixedMarkup: 0.024,
      includeVat: true
    });
    console.log('Next Energy Prices (with markup + VAT):', JSON.stringify(nextEnergyPrices.slice(0, 3), null, 2));

    // Get forecast prices with custom markup
    const customPrices = await stekker.getDutchPrices(null, null, true, {
      fixedMarkup: 0.03,
      variableMarkup: 5, // 5%
      includeVat: true
    });
    console.log('Custom Markup Prices:', JSON.stringify(customPrices.slice(0, 3), null, 2));

    return { rawPrices, nextEnergyPrices, customPrices };
  } catch (error) {
    console.error('Error fetching prices:', error.message);
  }
}

// Simple function to get just today's prices with optional markup
async function getTodayPrices(markupOptions = {}) {
  const stekker = new StekkerAPI();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  return await stekker.getDutchPrices(today, tomorrow, false, markupOptions);
}

// Export for use
module.exports = { StekkerAPI, getDutchEnergyPrices, getTodayPrices };

// Quick test with Next Energy markup
if (require.main === module) {
  getTodayPrices({
    fixedMarkup: 0.024, // Next Energy markup
    includeVat: true // Include 21% VAT
  })
    .then(prices => {
      console.log('Next Energy Prices (EUR/kWh with VAT):');
      prices.forEach(price => {
        const hour = new Date(price.time).getHours();
        console.log(`${hour.toString().padStart(2, '0')}:00 - €${price.price.toFixed(5)}/kWh`);
      });
    })
    .catch(console.error);
}
