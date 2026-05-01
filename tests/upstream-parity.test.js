// Live upstream parity test: ENTSOE vs Stekker.
// Skipped automatically if ENTSOE_API_KEY is absent (CI without secret, or local dev without key).
// When run, verifies:
//   - ENTSOE returns hourly-aggregated data of plausible volume for NL/today
//   - At least 90% of overlapping HH:00 hourly buckets agree with Stekker within €0.01/kWh
//
// Tolerances are deliberately loose because the comparison is across two different upstream sources
// with different settlement timing; the goal is to catch wholesale parsing/aggregation regressions,
// not to enforce exact equality.
const { EntsoeAPI } = require('../entsoe');
const { StekkerAPI } = require('../stekker');
const { aggregateToHourly } = require('../utils/helpers');

const HAS_KEY = Boolean(process.env.ENTSOE_API_KEY);
const describeIfKey = HAS_KEY ? describe : describe.skip;

describeIfKey('Upstream parity (ENTSOE vs Stekker)', () => {
  jest.setTimeout(30_000);

  const start = (() => {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - 1);
    return d;
  })();
  const end = (() => {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + 2);
    return d;
  })();

  test('ENTSOE returns plausible volume of NL prices', async () => {
    const entsoe = new EntsoeAPI(process.env.ENTSOE_API_KEY);
    const prices = await entsoe.getCountryPrices('nl', start, end);
    expect(prices.length).toBeGreaterThan(40); // 2 days × ≥20h, conservative floor
    const aggregated = aggregateToHourly(prices);
    expect(aggregated.length).toBeGreaterThan(20);
    // Each bucket should be a valid number
    for (const a of aggregated) expect(Number.isFinite(a.priceMwh)).toBe(true);
  });

  test('ENTSOE-aggregated and Stekker-aggregated NL prices agree within tolerance', async () => {
    const entsoe = new EntsoeAPI(process.env.ENTSOE_API_KEY);
    const stekker = new StekkerAPI({ region: 'NL' });

    const [entsoePrices, stekkerPrices] = await Promise.all([
      entsoe.getCountryPrices('nl', start, end),
      stekker.getDutchPrices(start, end, false, { fixedMarkup: 0, vat: 0, includeVat: false, roundTo: 5 })
    ]);

    const entsoeHourly = aggregateToHourly(entsoePrices);
    const stekkerHourly = aggregateToHourly(stekkerPrices);
    const stekkerByTime = new Map(stekkerHourly.map(p => [p.time, p.priceMwh]));

    let compared = 0;
    let agreeWithin = 0;
    for (const e of entsoeHourly) {
      const s = stekkerByTime.get(e.time);
      if (s == null) continue;
      compared += 1;
      // €0.01/kWh = €10/MWh. Loose tolerance — sources can differ during forecast horizon.
      if (Math.abs(e.priceMwh - s) < 10) agreeWithin += 1;
    }

    expect(compared).toBeGreaterThan(10);
    const ratio = agreeWithin / compared;
    expect(ratio).toBeGreaterThanOrEqual(0.9);
  });
});

if (!HAS_KEY) {
  // Make the skip visible in CI logs without failing the build.
  // eslint-disable-next-line no-console
  console.warn('upstream-parity.test.js: ENTSOE_API_KEY not set — skipping live parity tests.');
}
