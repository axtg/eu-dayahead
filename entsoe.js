// ENTSOE Transparency Platform client: day-ahead prices (documentType A44) and the wind, solar (A69) and
// demand (A65) forecasts. Prices come back in the {time, priceMwh, price} shape used by the rest of the app.
const parseXml = require('xml-js');

const { COUNTRIES } = require('./config/countries');
const { fetchText } = require('./utils/httpClient');

const RESOLUTION_MINUTES = { PT15M: 15, PT30M: 30, PT60M: 60 };
const SLOT_MINUTES = 15;
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

    const start = wholeHour(dateStart);
    const end = wholeHour(dateEnd);

    const path =
      `/api?securityToken=${encodeURIComponent(this.apiKey)}` +
      '&documentType=A44' +
      `&in_Domain=${country.biddingZone}` +
      `&out_Domain=${country.biddingZone}` +
      `&periodStart=${formatPeriod(start)}` +
      `&periodEnd=${formatPeriod(end)}`;

    const xml = await this.makeRequest(path);
    return this.parseResponse(xml, start, end);
  }

  // Forecast wind and solar production in MW, keyed by the start of each quarter hour in epoch ms.
  // A quarter is left out unless every production type in the response covers it, because a partial
  // sum would read far too low: ENTSOE can have offshore wind for hours where solar is still missing.
  async getWindSolarForecast(countryCode, dateStart, dateEnd) {
    const { biddingZone } = COUNTRIES[countryCode];
    const series = await this.fetchForecast(
      `documentType=A69&processType=A01&in_Domain=${biddingZone}`,
      dateStart,
      dateEnd
    );

    const byType = new Map();
    for (const item of series) {
      if (item['inBiddingZone_Domain.mRID'] === undefined) continue;
      const type = textOf(item.MktPSRType?.psrType);
      if (!byType.has(type)) byType.set(type, new Map());
      addQuarters(byType.get(type), item);
    }

    const totals = new Map();
    const counts = new Map();
    for (const quarters of byType.values()) {
      for (const [time, amount] of quarters) {
        totals.set(time, (totals.get(time) || 0) + amount);
        counts.set(time, (counts.get(time) || 0) + 1);
      }
    }
    for (const time of totals.keys()) {
      if (counts.get(time) < byType.size) totals.delete(time);
    }
    return totals;
  }

  // Forecast demand in MW, keyed by the start of each quarter hour in epoch ms.
  async getLoadForecast(countryCode, dateStart, dateEnd) {
    const { biddingZone } = COUNTRIES[countryCode];
    const series = await this.fetchForecast(
      `documentType=A65&processType=A01&outBiddingZone_Domain=${biddingZone}`,
      dateStart,
      dateEnd
    );
    const quarters = new Map();
    for (const item of series) addQuarters(quarters, item);
    return quarters;
  }

  async fetchForecast(query, dateStart, dateEnd) {
    const path =
      `/api?securityToken=${encodeURIComponent(this.apiKey)}&${query}` +
      `&periodStart=${formatPeriod(wholeHour(dateStart))}` +
      `&periodEnd=${formatPeriod(wholeHour(dateEnd))}`;
    const json = toJson(await this.makeRequest(path));
    const doc = json.GL_MarketDocument;
    if (!doc) throwForMissingDocument(json);
    return asArray(doc.TimeSeries);
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
    const json = toJson(xmlData);

    const doc = json.Publication_MarketDocument;
    if (!doc) throwForMissingDocument(json);
    if (doc.Reason) {
      const code = textOf(doc.Reason.code);
      const text = textOf(doc.Reason.text);
      throw new Error(`ENTSOE reason ${code || ''}: ${text || 'no data'}`);
    }

    const timeSeries = asArray(doc.TimeSeries);

    // Dedupe by ISO timestamp, in case TimeSeries blocks overlap.
    const byTime = new Map();

    for (const series of timeSeries) {
      // Zones such as DE and AT also return a sequence 2 series with different prices, which can be
      // the only series for a future day. Sequence 1 (or none) matches the day-ahead benchmark.
      const sequence = textOf(series[SEQUENCE_FIELD]);
      if (sequence != null && Number(sequence) !== 1) continue;

      for (const period of asArray(series.Period)) {
        for (const { time, amount, stepMin } of periodPoints(period, 'price.amount')) {
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

function wholeHour(date) {
  const hour = new Date(date);
  hour.setMinutes(0, 0, 0);
  return hour;
}

function formatPeriod(date) {
  return date.toISOString().replace(/[-:T]/g, '').slice(0, 12);
}

function toJson(xml) {
  return parseXml.xml2js(xml, { compact: true, nativeType: true, ignoreDeclaration: true, ignoreAttributes: true });
}

function throwForMissingDocument(json) {
  const ack = json.Acknowledgement_MarketDocument;
  if (!ack) throw new Error('ENTSOE: unexpected response (no market document)');
  const code = textOf(ack.Reason?.code);
  const text = textOf(ack.Reason?.text);
  throw new Error(`ENTSOE acknowledgement ${code || ''}: ${text || 'no data'}`);
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

// Every point in a period, in order. Curve type A03 omits a point when its value equals the previous one,
// so the value is carried forward.
function periodPoints(period, field) {
  const stepMin = RESOLUTION_MINUTES[textOf(period.resolution)];
  const startIso = textOf(period.timeInterval?.start);
  if (!stepMin || !startIso) return [];
  const periodStart = new Date(startIso);

  const amountByPosition = new Map();
  for (const point of asArray(period.Point)) {
    const position = Number(textOf(point.position));
    const amount = parseFloat(textOf(point[field]));
    if (Number.isFinite(amount) && Number.isFinite(position)) amountByPosition.set(position, amount);
  }
  if (amountByPosition.size === 0) return [];

  const periodMinutes = (new Date(textOf(period.timeInterval?.end)) - periodStart) / 60_000;
  const lastPosition = Number.isFinite(periodMinutes)
    ? Math.round(periodMinutes / stepMin)
    : Math.max(...amountByPosition.keys());

  const points = [];
  let amount = null;
  for (let position = 1; position <= lastPosition; position += 1) {
    if (amountByPosition.has(position)) amount = amountByPosition.get(position);
    if (amount === null) continue;
    points.push({ time: new Date(periodStart.getTime() + (position - 1) * stepMin * 60_000), amount, stepMin });
  }
  return points;
}

// Some zones publish some forecasts hourly, so every value is spread over quarter hours to line them up.
function addQuarters(quarters, series) {
  for (const period of asArray(series.Period)) {
    for (const { time, amount, stepMin } of periodPoints(period, 'quantity')) {
      for (let offset = 0; offset < stepMin; offset += SLOT_MINUTES) {
        quarters.set(time.getTime() + offset * 60_000, amount);
      }
    }
  }
}

function textOf(node) {
  if (node == null) return null;
  if (typeof node === 'object') return node._text ?? null;
  return node;
}

module.exports = { EntsoeAPI };
