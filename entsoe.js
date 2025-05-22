// ENTSOE API for Dutch Energy Prices
// Based on the entsoe.js implementation from powerhour

const https = require('https');
const parseXml = require('xml-js'); // You'll need: npm install xml-js

class EntsoeAPI {
  constructor(apiKey) {
    this.apiKey = apiKey; // Get free API key from: https://transparency.entsoe.eu/
    this.host = 'web-api.tp.entsoe.eu';
    this.port = 443;
    this.timeout = 30000;
    this.biddingZone = '10YNL----------L'; // Netherlands
  }

  async getDutchPrices(dateStart, dateEnd) {
    try {
      const start = dateStart || new Date();
      const end = dateEnd || new Date(Date.now() + 24 * 60 * 60 * 1000); // tomorrow
      
      start.setMinutes(0, 0, 0);
      end.setMinutes(0, 0, 0);
      
      const periodStart = start.toISOString().replace(/[-:T]/g, '').slice(0, 12);
      const periodEnd = end.toISOString().replace(/[-:T]/g, '').slice(0, 12);
      
      const path = `/api?securityToken=${this.apiKey}&documentType=A44&in_Domain=${this.biddingZone}&out_Domain=${this.biddingZone}&periodStart=${periodStart}&periodEnd=${periodEnd}`;
      
      const response = await this.makeRequest(path);
      return this.parseResponse(response, start, end);
    } catch (error) {
      throw new Error(`ENTSOE API Error: ${error.message}`);
    }
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

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
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

  parseResponse(xmlData, start, end) {
    const parseOptions = {
      compact: true, 
      nativeType: true, 
      ignoreDeclaration: true, 
      ignoreAttributes: true
    };
    
    const json = parseXml.xml2js(xmlData, parseOptions);
    const flatJson = this.flatten(json);
    
    let prices = [];
    
    if (flatJson.Publication_MarketDocument && flatJson.Publication_MarketDocument.TimeSeries) {
      let timeSeries = flatJson.Publication_MarketDocument.TimeSeries;
      
      // Handle multiple days
      if (!Array.isArray(timeSeries)) {
        timeSeries = [timeSeries];
      }
      
      timeSeries.forEach(day => {
        if (day.Period && day.Period.resolution === 'PT60M') {
          const startDate = new Date(day.Period.timeInterval.start);
          const points = Array.isArray(day.Period.Point) ? day.Period.Point : [day.Period.Point];
          
          points.forEach(point => {
            const hour = point.position - 1;
            const time = new Date(startDate);
            time.setHours(time.getHours() + hour);
            
            if (time >= start && time <= end) {
              prices.push({
                time: time.toISOString(),
                price: parseFloat(point['price.amount']), // EUR/MWh
                pricePerKwh: parseFloat(point['price.amount']) / 1000 // EUR/kWh
              });
            }
          });
        }
      });
    }
    
    return prices.sort((a, b) => new Date(a.time) - new Date(b.time));
  }

  flatten(json, level = 1) {
    if (level > 10) return json;
    
    const flat = {};
    Object.keys(json).forEach(key => {
      if (key === '_attributes') {
        Object.keys(json[key]).forEach(attr => {
          flat[attr] = json[key][attr];
        });
        return;
      }
      
      flat[key] = json[key];
      if (typeof json[key] === 'object' && json[key] !== null) {
        if (Object.keys(json[key]).length === 1 && json[key]._text) {
          flat[key] = json[key]._text;
        } else if (Object.keys(json[key]).length > 0) {
          flat[key] = this.flatten(json[key], level + 1);
        }
      }
    });
    
    return flat;
  }
}

// Usage Example
async function getDutchEnergyPrices() {
  const apiKey = 'YOUR_ENTSOE_API_KEY'; // Get from https://transparency.entsoe.eu/
  const entsoe = new EntsoeAPI(apiKey);
  
  try {
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    const prices = await entsoe.getDutchPrices(today, tomorrow);
    console.log('Dutch Energy Prices:', JSON.stringify(prices, null, 2));
    return prices;
  } catch (error) {
    console.error('Error fetching prices:', error.message);
  }
}

// Export for use
module.exports = { EntsoeAPI, getDutchEnergyPrices };