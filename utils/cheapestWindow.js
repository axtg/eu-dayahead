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

// The continuous block of `hours` with the lowest average price on a local date, inside the local
// hours from-to. Returns null if the date doesn't have all its prices, or the block doesn't fit.
function findCheapestWindow(prices, { date, timezone, hours, resolutionMinutes, from = 0, to = 24 }) {
  const stepMs = resolutionMinutes * MINUTE_MS;
  const dayStart = localHourToUtc(date, 0, timezone);
  const dayEnd = localHourToUtc(date, 24, timezone);
  const dayPrices = pricesForCompleteDay(prices, dayStart, dayEnd, stepMs);
  if (!dayPrices) return null;

  const earliestStart = localHourToUtc(date, from, timezone);
  const latestEnd = localHourToUtc(date, to, timezone);
  const slots = (hours * 60) / resolutionMinutes;

  let best = null;
  for (let i = 0; i + slots <= dayPrices.length; i += 1) {
    const start = dayStart + i * stepMs;
    const end = start + slots * stepMs;
    if (start < earliestStart || end > latestEnd) continue;

    const total = dayPrices.slice(i, i + slots).reduce((sum, { price }) => sum + price, 0);
    const averagePrice = total / slots;
    if (!best || averagePrice < best.averagePrice) best = { start, end, averagePrice };
  }
  if (!best) return null;

  return {
    date,
    start: new Date(best.start).toISOString(),
    end: new Date(best.end).toISOString(),
    averagePrice: best.averagePrice
  };
}

module.exports = { findCheapestWindow, localDate };
