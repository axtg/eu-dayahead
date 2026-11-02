const MAX_LINE_OCTETS = 75;

function escapeText(text) {
  return text.replace(/[\\;,]/g, '\\$&').replace(/\n/g, '\\n');
}

function formatUtc(iso) {
  return `${new Date(iso).toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
}

// RFC 5545 limits lines to 75 octets. Continuation lines start with a space, which counts.
function foldLine(line) {
  const parts = [];
  let current = '';
  let octets = 0;
  for (const character of line) {
    const size = Buffer.byteLength(character);
    if (octets + size > MAX_LINE_OCTETS) {
      parts.push(current);
      current = ' ';
      octets = 1;
    }
    current += character;
    octets += size;
  }
  parts.push(current);
  return parts.join('\r\n');
}

// DTSTAMP stays fixed for an unchanged window, so identical feeds stay byte-identical and
// calendar apps can get a 304. Times are UTC, so no VTIMEZONE is needed.
function eventLines({ uid, start, end, summary, description }) {
  return [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${formatUtc(start)}`,
    `DTSTART:${formatUtc(start)}`,
    `DTEND:${formatUtc(end)}`,
    `SUMMARY:${escapeText(summary)}`,
    `DESCRIPTION:${escapeText(description)}`,
    'TRANSP:TRANSPARENT',
    'END:VEVENT'
  ];
}

function buildCalendar({ name, events }) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//xadi.eu//EU Day-Ahead Prices//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(name)}`,
    ...events.flatMap(eventLines),
    'END:VCALENDAR'
  ];
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

module.exports = { buildCalendar };
