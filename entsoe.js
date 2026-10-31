// ENTSOE Transparency Platform client (day-ahead prices, documentType A44).
// Returns hourly or quarterly prices in the {time, priceMwh, price} shape used by the rest of the app.
const parseXml = require('xml-js');

const { COUNTRIES } = require('./config/countries');
const { fetchText } = require('./utils/httpClient');

const RESOLUTION_MINUTES = { PT15M: 15, PT30M: 30, PT60M: 60 };
const SEQUENCE_FIELD = 'classificationSequence_AttributeInstanceComponent.position';

class EntsoeAPI {
  constructor(apiKey, options = {}) {
    this.apiKey = apiKey;
    this.host = 'web-api.tp.entsoe.eu';
    this.port = 443;
    // With Stekker's 6s fallback this stays under nginx's 30s proxy_read_timeout.
    this.timeout = options.timeout || 22000;
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
      `/api?securityToken=${encodeURIComponent(this.apiKey)}` +
      '&documentType=A44' +
      `&in_Domain=${country.biddingZone}` +
      `&out_Domain=${country.biddingZone}` +
      `&periodStart=${periodStart}` +
      `&periodEnd=${periodEnd}`;

    const xml = await this.makeRequest(path);
    return this.parseResponse(xml, start, end);
  }

  async makeRequest(path) {
    const { status, body } = await fetchText(`https://${this.host}:${this.port}${path}`, { timeoutMs: this.timeout });
    if (status !== 200) {
      const reason = (body.match(/<text>([^<]+)<\/text>/) || [])[1] || `HTTP ${status}`;
      throw new Error(`ENTSOE ${status}: ${reason}`);
    }
    return body;
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

    // Dedupe by ISO timestamp, in case TimeSeries blocks overlap.
    const byTime = new Map();

    for (const series of timeSeries) {
      // Zones such as DE and AT also return a sequence 2 series with different prices, which can be
      // the only series for a future day. Sequence 1 (or none) matches the day-ahead benchmark.
      const sequence = textOf(series[SEQUENCE_FIELD]);
      if (sequence != null && Number(sequence) !== 1) continue;

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

        const amountByPosition = new Map();
        for (const point of points) {
          const position = Number(textOf(point.position));
          const amount = parseFloat(textOf(point['price.amount']));
          if (Number.isFinite(amount) && Number.isFinite(position)) amountByPosition.set(position, amount);
        }
        if (amountByPosition.size === 0) continue;

        const periodMinutes = (new Date(textOf(period.timeInterval?.end)) - periodStart) / 60_000;
        const lastPosition = Number.isFinite(periodMinutes)
          ? Math.round(periodMinutes / stepMin)
          : Math.max(...amountByPosition.keys());

        // Curve type A03 omits a point when its price equals the previous one, so carry the price forward.
        let amount = null;
        for (let position = 1; position <= lastPosition; position += 1) {
          if (amountByPosition.has(position)) amount = amountByPosition.get(position);
          if (amount === null) continue;

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
}

function textOf(node) {
  if (node == null) return null;
  if (typeof node === 'object') return node._text ?? null;
  return node;
}

module.exports = { EntsoeAPI };
