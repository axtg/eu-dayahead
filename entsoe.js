// ENTSOE Transparency Platform client (day-ahead prices, documentType A44).
// Returns hourly or quarterly prices in the {time, priceMwh, price} shape used by the rest of the app.
const https = require('https');
const parseXml = require('xml-js');

const { COUNTRIES } = require('./config/countries');

const RESOLUTION_MINUTES = { PT15M: 15, PT30M: 30, PT60M: 60 };

class EntsoeAPI {
  constructor(apiKey, options = {}) {
    this.apiKey = apiKey;
    this.host = 'web-api.tp.entsoe.eu';
    this.port = 443;
    this.timeout = options.timeout || 15000;
  }

  async getCountryPrices(countryCode, dateStart, dateEnd) {
    const country = COUNTRIES[countryCode];
    if (!country) throw new Error(`ENTSOE: unsupported country ${countryCode}`);
    if (!this.apiKey) throw new Error('ENTSOE: no API key configured');

    const start = new Date(dateStart);
    const end = new Date(dateEnd);
    start.setMinutes(0, 0, 0);
    end.setMinutes(0, 0, 0);

    const periodStart = start.toISOString().replace(/[-:T]/g, '').slice(0, 12);
    const periodEnd = end.toISOString().replace(/[-:T]/g, '').slice(0, 12);

    const path =
      `/api?securityToken=${this.apiKey}` +
      '&documentType=A44' +
      `&in_Domain=${country.biddingZone}` +
      `&out_Domain=${country.biddingZone}` +
      `&periodStart=${periodStart}` +
      `&periodEnd=${periodEnd}`;

    const xml = await this.makeRequest(path);
    return this.parseResponse(xml, start, end);
  }

  async makeRequest(path) {
    return new Promise((resolve, reject) => {
      const req = https.request(
        { hostname: this.host, port: this.port, path, method: 'GET', timeout: this.timeout },
        res => {
          let body = '';
          res.on('data', chunk => (body += chunk));
          res.on('end', () => {
            if (res.statusCode !== 200) {
              const reason = (body.match(/<text>([^<]+)<\/text>/) || [])[1] || `HTTP ${res.statusCode}`;
              return reject(new Error(`ENTSOE ${res.statusCode}: ${reason}`));
            }
            resolve(body);
          });
        }
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('ENTSOE request timeout'));
      });
      req.end();
    });
  }

  parseResponse(xmlData, windowStart, windowEnd) {
    const json = parseXml.xml2js(xmlData, {
      compact: true,
      nativeType: true,
      ignoreDeclaration: true,
      ignoreAttributes: true
    });

    const doc = json.Publication_MarketDocument;
    if (!doc) {
      const ack = json.Acknowledgement_MarketDocument;
      if (ack) {
        const code = textOf(ack.Reason?.code);
        const text = textOf(ack.Reason?.text);
        throw new Error(`ENTSOE acknowledgement ${code || ''}: ${text || 'no data'}`);
      }
      throw new Error('ENTSOE: unexpected response (no Publication_MarketDocument)');
    }
    if (doc.Reason) {
      const code = textOf(doc.Reason.code);
      const text = textOf(doc.Reason.text);
      throw new Error(`ENTSOE reason ${code || ''}: ${text || 'no data'}`);
    }

    let timeSeries = doc.TimeSeries;
    if (!timeSeries) return [];
    if (!Array.isArray(timeSeries)) timeSeries = [timeSeries];

    // Dedupe by ISO timestamp — multiple TimeSeries blocks (e.g. DE) can repeat the same intervals.
    const byTime = new Map();

    for (const series of timeSeries) {
      let periods = series.Period;
      if (!periods) continue;
      if (!Array.isArray(periods)) periods = [periods];

      for (const period of periods) {
        const resolution = textOf(period.resolution);
        const stepMin = RESOLUTION_MINUTES[resolution];
        if (!stepMin) continue;

        const startIso = textOf(period.timeInterval?.start);
        if (!startIso) continue;
        const periodStart = new Date(startIso);

        let points = period.Point;
        if (!points) continue;
        if (!Array.isArray(points)) points = [points];

        for (const point of points) {
          const position = Number(textOf(point.position));
          const amountRaw = textOf(point['price.amount']);
          const amount = parseFloat(amountRaw);
          if (!Number.isFinite(amount) || !Number.isFinite(position)) continue;

          const time = new Date(periodStart.getTime() + (position - 1) * stepMin * 60_000);
          if (windowStart && time < windowStart) continue;
          if (windowEnd && time >= windowEnd) continue;

          byTime.set(time.toISOString(), {
            time: time.toISOString(),
            priceMwh: amount,
            price: amount / 1000,
            resolutionMinutes: stepMin
          });
        }
      }
    }

    return [...byTime.values()].sort((a, b) => new Date(a.time) - new Date(b.time));
  }

  // Backward-compat shim — the only consumer was the example block at the bottom of this file.
  getDutchPrices(dateStart, dateEnd) {
    return this.getCountryPrices('nl', dateStart, dateEnd);
  }
}

function textOf(node) {
  if (node == null) return null;
  if (typeof node === 'object') return node._text ?? null;
  return node;
}

module.exports = { EntsoeAPI };

if (require.main === module) {
  require('dotenv').config();
  const apiKey = process.env.ENTSOE_API_KEY;
  if (!apiKey) {
    console.error('Set ENTSOE_API_KEY in .env');
    process.exit(1);
  }
  const e = new EntsoeAPI(apiKey);
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 2);
  e.getCountryPrices('nl', start, end)
    .then(prices => {
      console.log(`Got ${prices.length} prices, sample:`, prices.slice(0, 3));
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
