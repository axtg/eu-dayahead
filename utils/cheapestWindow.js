const { formatInTimeZone, fromZonedTime } = require('date-fns-tz');

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

// The calendar date in a timezone, as yyyy-MM-dd. Date.UTC handles month and year ends.
function localDate(now, timezone, dayOffset = 0) {
  const [year, month, day] = formatInTimeZone(now, timezone, 'yyyy-MM-dd').split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + dayOffset)).toISOString().slice(0, 10);
}

// Goes through wall-clock time because local hours aren't a fixed offset from midnight on daylight saving days.
function localHourToUtc(date, hour, timezone) {
  if (hour === 24) {
    const nextDate = new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
    return fromZonedTime(`${nextDate}T00:00:00`, timezone).getTime();
  }
  return fromZonedTime(`${date}T${String(hour).padStart(2, '0')}:00:00`, timezone).getTime();
}

function pricesForCompleteDay(prices, dayStart, dayEnd, stepMs) {
  const dayPrices = prices.filter(({ time }) => {
    const ms = new Date(time).getTime();
    return ms >= dayStart && ms < dayEnd;
  });
  const complete =
    dayPrices.length === (dayEnd - dayStart) / stepMs &&
    dayPrices.every(({ time }, i) => new Date(time).getTime() === dayStart + i * stepMs);
  return complete ? dayPrices : null;
}

// Lowest average over `slots` consecutive prices. Equal averages go to the earliest start.
function cheapestBlock(prices, { earliestStart, startsBefore, latestEnd, slots, stepMs }) {
  let best = null;
  for (let i = 0; i + slots <= prices.length; i += 1) {
    const start = new Date(prices[i].time).getTime();
    const end = start + slots * stepMs;
    if (start < earliestStart || start >= startsBefore || end > latestEnd) continue;

    const block = prices.slice(i, i + slots);
    if (!block.every(({ time }, j) => new Date(time).getTime() === start + j * stepMs)) continue;

    const averagePrice = block.reduce((sum, { price }) => sum + price, 0) / slots;
    if (!best || averagePrice < best.averagePrice) best = { start, end, averagePrice };
  }
  return best;
}

function toWindow(date, { start, end, averagePrice }) {
  return {
    date,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    averagePrice
  };
}

// The continuous block of `hours` with the lowest average price on a local date, inside the local
// hours from-to. Returns null if the date doesn't have all its prices, or the block doesn't fit.
function findCheapestWindow(prices, { date, timezone, hours, resolutionMinutes, from = 0, to = 24 }) {
  const stepMs = resolutionMinutes * MINUTE_MS;
  const dayStart = localHourToUtc(date, 0, timezone);
  const dayEnd = localHourToUtc(date, 24, timezone);
  const dayPrices = pricesForCompleteDay(prices, dayStart, dayEnd, stepMs);
  if (!dayPrices) return null;

  const best = cheapestBlock(dayPrices, {
    earliestStart: localHourToUtc(date, from, timezone),
    startsBefore: dayEnd,
    latestEnd: localHourToUtc(date, to, timezone),
    slots: (hours * 60) / resolutionMinutes,
    stepMs
  });
  return best && toWindow(date, best);
}

// The cheapest block that starts on a local date, from `now` and local hour `from` onward. Without `to`
// it can run into the next day as far as prices are known, because an appliance doesn't stop at midnight.
// `to` is the latest finish on the date. Parts of a price step round up, so 3.5 hours on hourly prices is 4.
function findUpcomingWindow(prices, { date, timezone, hours, resolutionMinutes, now, from = 0, to }) {
  const stepMs = resolutionMinutes * MINUTE_MS;
  const dayEnd = localHourToUtc(date, 24, timezone);
  if (!hasCompleteDay(prices, { date, timezone, resolutionMinutes })) return null;

  const best = cheapestBlock(prices, {
    earliestStart: Math.max(now.getTime(), localHourToUtc(date, from, timezone)),
    startsBefore: dayEnd,
    latestEnd: to === undefined ? Infinity : localHourToUtc(date, to, timezone),
    slots: Math.ceil((hours * 60) / resolutionMinutes),
    stepMs
  });
  return best && toWindow(date, best);
}

function hasCompleteDay(prices, { date, timezone, resolutionMinutes }) {
  const dayStart = localHourToUtc(date, 0, timezone);
  const dayEnd = localHourToUtc(date, 24, timezone);
  return pricesForCompleteDay(prices, dayStart, dayEnd, resolutionMinutes * MINUTE_MS) !== null;
}

module.exports = { findCheapestWindow, findUpcomingWindow, hasCompleteDay, localDate };
