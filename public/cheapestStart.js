// Picks when to start an appliance with a "start in X hours" timer. Loaded by the page and by the Jest tests.
(function () {
  const MINUTE_MS = 60_000;
  const HOUR_MS = 60 * MINUTE_MS;
  const MAX_DELAY_HOURS = 20;
  // Windows this close in price count as equal, so rounding errors can't move the answer later.
  const PRICE_TOLERANCE = 1e-9;

  // The average price over start-end, weighted by how long each price applies. Null if any of it has no price.
  function averageOver(priceList, startMs, endMs, stepMs) {
    let weightedSum = 0;
    let coveredMs = 0;
    for (const { time, price } of priceList) {
      const slotStart = new Date(time).getTime();
      const overlapMs = Math.min(endMs, slotStart + stepMs) - Math.max(startMs, slotStart);
      if (overlapMs > 0) {
        weightedSum += price * overlapMs;
        coveredMs += overlapMs;
      }
    }
    return coveredMs === endMs - startMs ? weightedSum / coveredMs : null;
  }

  function findCheapestStart(priceList, { lengthMinutes, resolutionMinutes, nowMs }) {
    const stepMs = resolutionMinutes * MINUTE_MS;
    let best = null;
    for (let delayHours = 0; delayHours <= MAX_DELAY_HOURS; delayHours += 1) {
      const startMs = nowMs + delayHours * HOUR_MS;
      const endMs = startMs + lengthMinutes * MINUTE_MS;
      const averagePrice = averageOver(priceList, startMs, endMs, stepMs);
      if (averagePrice !== null && (!best || averagePrice < best.averagePrice - PRICE_TOLERANCE)) {
        best = {
          delayHours,
          start: new Date(startMs).toISOString(),
          end: new Date(endMs).toISOString(),
          averagePrice
        };
      }
    }
    return best;
  }

  function startLabel(delayHours) {
    if (delayHours === 0) return 'Start now';
    return `Start in ${delayHours} ${delayHours === 1 ? 'hour' : 'hours'}`;
  }

  function formatLength(minutes) {
    return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
  }

  const api = { findCheapestStart, startLabel, formatLength };
  if (typeof module !== 'undefined') module.exports = api;
  else globalThis.CheapestStart = api;
})();
