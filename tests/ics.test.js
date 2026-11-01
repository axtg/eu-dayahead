const { buildCalendar } = require('../utils/ics');

const EVENT = {
  uid: 'nl-2026-11-02@dap.xadi.eu',
  start: '2026-11-02T11:15:00.000Z',
  end: '2026-11-02T15:15:00.000Z',
  summary: 'Cheapest 4h',
  description: 'Some text'
};

const build = (events = [EVENT], name = 'Prices') => buildCalendar({ name, events });
const unfold = ics => ics.replace(/\r\n /g, '');

describe('buildCalendar', () => {
  test('writes a calendar with one event per window', () => {
    const lines = build().split('\r\n');

    expect(lines[0]).toBe('BEGIN:VCALENDAR');
    expect(lines).toEqual(expect.arrayContaining(['VERSION:2.0', 'X-WR-CALNAME:Prices', 'END:VCALENDAR']));
    expect(lines).toEqual(
      expect.arrayContaining([
        'BEGIN:VEVENT',
        'UID:nl-2026-11-02@dap.xadi.eu',
        'DTSTART:20261102T111500Z',
        'DTEND:20261102T151500Z',
        'SUMMARY:Cheapest 4h',
        'DESCRIPTION:Some text',
        'END:VEVENT'
      ])
    );
    expect(lines.some(line => line.startsWith('PRODID:'))).toBe(true);
    expect(lines.some(line => line.startsWith('DTSTAMP:'))).toBe(true);
  });

  test('every line ends in CRLF', () => {
    const ics = build();

    expect(ics.endsWith('\r\n')).toBe(true);
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  });

  test('windows do not mark the calendar as busy', () => {
    expect(build()).toContain('TRANSP:TRANSPARENT');
  });

  test('the same events give the same output', () => {
    expect(build()).toBe(build());
  });

  test('escapes special characters in text', () => {
    const ics = build([{ ...EVENT, summary: 'a,b;c\\d', description: 'one\ntwo' }]);

    expect(ics).toContain(String.raw`SUMMARY:a\,b\;c\\d`);
    expect(ics).toContain('DESCRIPTION:one\\ntwo');
  });

  test('folds long lines at 75 octets without splitting characters', () => {
    const description = '€'.repeat(100);
    const ics = build([{ ...EVENT, description }]);

    for (const line of ics.split('\r\n')) {
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
      expect(line).not.toContain('�');
    }
    expect(unfold(ics)).toContain(`DESCRIPTION:${description}`);
  });

  test('a calendar without events is still valid', () => {
    expect(build([])).not.toContain('BEGIN:VEVENT');
  });
});
