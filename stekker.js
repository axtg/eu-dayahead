// Stekker.app API for Dutch Energy Prices
// Based on the stekker.js implementation from powerhour

const { fetchText } = require('./utils/httpClient');

class StekkerAPI {
  constructor(options = {}) {
    this.host = 'stekker.app';
    this.port = 443;
    this.timeout = options.timeout || 6000;
    this.region = options.region || 'NL';
  }

  async getDutchPrices(dateStart, dateEnd, includeForecast = false, options = {}) {
    try {
      const today = new Date();
      const tomorrow = new Date(today);
      tomorrow.setDate(today.getDate() + 1);

      // Clone caller-owned Dates before mutating.
      const start = new Date(dateStart || today);
      const end = new Date(dateEnd || tomorrow);

      start.setMinutes(0, 0, 0);
      end.setDate(end.getDate() + 1); // Include full end day

      const startDate = start.toISOString();
      const endDate = end.toISOString();

      let path = `/epex-forecast?advanced_view=&region=${encodeURIComponent(this.region)}&unit=MWh`;
      if (!includeForecast) {
        path += `&filter_from=${startDate}&filter_to=${endDate}`;
      }

      const response = await this.makeRequest(path);
      const prices = this.parseResponse(response, start, end, includeForecast);

      return this.applyMarkup(prices, options);
    } catch (error) {
      throw new Error(`Stekker API Error: ${error.message}`);
    }
  }

  applyMarkup(prices, options = {}) {
    const {
      fixedMarkup = 0, // Fixed markup in EUR/kWh (e.g., 0.024 for Next Energy)
      variableMarkup = 0, // Variable markup in % (e.g., 5 for 5%)
      vat: vatRate = 0, // VAT as decimal (e.g., 0.21 for 21%)
      roundTo = 5 // Round to 5 decimal places
    } = options;

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
          vatPercent: `${Number((vatRate * 100).toFixed(1))}%`,
          originalPrice: hour.price
        }
      };
    });
  }

  async makeRequest(path) {
    const { status, body } = await fetchText(`https://${this.host}:${this.port}${path}`, { timeoutMs: this.timeout });
    // The body stays out of the message, because route handlers return error messages to API clients.
    if (status !== 200) throw new Error(`HTTP ${status}`);
    return body;
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
        price: prices[idx] != null ? prices[idx] / 1000 : null // EUR/kWh (consumer-friendly)
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

module.exports = { StekkerAPI };
