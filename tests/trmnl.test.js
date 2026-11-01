const { readFileSync } = require('fs');
const path = require('path');
const vm = require('vm');
const { INFO_PANEL_HEIGHT, loadSettings, renderPollingUrl, renderLayout } = require('./trmnl/harness');

const PLUGIN_DIR = path.join(__dirname, '..', 'integrations', 'trmnl-70055-energy_day_ahead_prices');
const SETTINGS_PATH = path.join(PLUGIN_DIR, 'settings.yml');
const SHARED_SOURCE = readFileSync(path.join(PLUGIN_DIR, 'shared.liquid'), 'utf8');
const BASE_FIELDS = { country: 'nl', timeframe: 'next24h', resolution: '60M', markup: 0 };
const LANGUAGES = ['en', 'nl', 'de', 'fr', 'da', 'nb', 'sv'];
const STRING_KEYS = [
  'titleToday',
  'titleNext',
  'yAxis',
  'bestPeriod',
  'noPrices',
  'warnFallbackSource',
  'warnStaleData',
  'warnIncompleteData',
  'warnGeneric'
];
const SIZES = {
  full: { chartHeight: 400, titleSize: '18px', axisSize: '13px', infoSize: '16px', maxLabels: 24 },
  half_horizontal: { chartHeight: 215, titleSize: '14px', axisSize: '13px', infoSize: '12px', maxLabels: 24 },
  half_vertical: { chartHeight: 400, titleSize: '16px', axisSize: '10px', infoSize: '12px', maxLabels: 12 },
  quadrant: { chartHeight: 215, titleSize: '14px', axisSize: '13px', infoSize: '12px', maxLabels: 12 }
};
const LAYOUTS = Object.keys(SIZES);

const settings = loadSettings();
const field = key => settings.custom_fields.find(f => f.keyname === key);
const optionValues = key =>
  field(key).options.map(option => {
    if (typeof option === 'object' && option !== null) {
      return String(Object.values(option)[0]);
    }
    return String(option);
  });

const fixture = name => JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'trmnl', `${name}.json`), 'utf8'));

const STRINGS = vm.runInNewContext(`(${SHARED_SOURCE.match(/const STRINGS = (\{[\s\S]*?\n {2}\});/)?.[1] ?? '{}'})`);

// Every render asserts no script error, so a thrown error can't pass as "no chart"
async function render(layout, response, fieldValues = { language: 'en' }, options = {}) {
  const result = await renderLayout(layout, { response, fieldValues, user: { locale: 'en' }, ...options });
  expect(result.errors).toEqual([]);
  return result;
}

const formatDate = (language, timezone, time) =>
  new Intl.DateTimeFormat(language, { timeZone: timezone, day: 'numeric', month: 'short' }).format(new Date(time));
const formatTime = (language, timezone, time) =>
  new Intl.DateTimeFormat(language, {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(new Date(time));

describe('settings', () => {
  test('adds the new fields as optional', () => {
    for (const key of ['variable_markup', 'round_to', 'best_period_hours', 'language']) {
      expect(field(key).optional).toBe(true);
    }
  });

  test('vat is optional with no default, and says how to enter it', () => {
    expect(field('vat').optional).toBe(true);
    expect(field('vat')).not.toHaveProperty('default');
    expect(field('vat').description).toMatch(/blank/i);
    expect(field('vat').description).toContain('0.21, not 21');
  });

  test('round_to has no default', () => {
    expect(field('round_to')).not.toHaveProperty('default');
  });

  test('select option values are quoted in the raw text', () => {
    const lines = readFileSync(SETTINGS_PATH, 'utf8').split('\n');
    for (const key of ['country', 'timeframe', 'round_to', 'best_period_hours', 'language']) {
      const start = lines.findIndex(line => line === `- keyname: ${key}`);
      const optionsAt = lines.indexOf('  options:', start);
      const values = [];
      for (let i = optionsAt + 1; lines[i].startsWith('  - '); i++) {
        values.push(lines[i].slice(lines[i].lastIndexOf(': ') + 2));
      }
      expect(values.length).toBeGreaterThan(0);
      for (const value of values) {
        expect(value).toMatch(/^'[^']+'$/);
      }
    }
  });

  test('country options are all 9, NL first and default, in lower case', () => {
    const values = optionValues('country');
    expect(values[0]).toBe('nl');
    expect([...values].sort()).toEqual(['at', 'be', 'ch', 'de', 'dk', 'fr', 'nl', 'no', 'se']);
    expect(field('country').default).toBe('nl');
  });

  test('Norway is quoted, because Ruby YAML reads it as false', () => {
    expect(readFileSync(SETTINGS_PATH, 'utf8')).toMatch(/- Norway: 'no'/);
  });

  test('resolution options stay as they are', () => {
    expect(optionValues('resolution')).toEqual(['15M', '60M']);
    expect(field('resolution').default).toBe('60M');
  });

  test('timeframe options', () => {
    expect(optionValues('timeframe')).toEqual(['today', 'next12', 'next24h', 'nextall']);
    expect(field('timeframe').default).toBe('next24h');
  });

  test('language options', () => {
    expect(optionValues('language')).toEqual(['device', ...LANGUAGES]);
  });

  test('numeric selects use labelled, quoted values', () => {
    expect(optionValues('round_to')).toEqual(['2', '3', '4', '5']);
    expect(optionValues('best_period_hours')).toEqual(['1', '2', '3', '4', '6', '8']);
  });

  test('the name and author bio no longer say NL', () => {
    expect(settings.name).toBe('EU Energy Day Ahead Prices');
    expect(field('xadi.eu').description).not.toContain('NL');
  });

  test('markup steps in tenths of a cent', () => {
    expect(field('markup').step).toBe(0.001);
    expect(field('markup').description).toContain('0.12 = 12 cents');
  });

  test('framework_version and refresh_interval are unchanged', () => {
    expect(settings.framework_version).toBe('2.3.7');
    expect(settings.refresh_interval).toBe(120);
  });

  test('every plugin file is at most 100 KB', () => {
    for (const name of ['settings.yml', 'shared.liquid', ...LAYOUTS.map(layout => `${layout}.liquid`)]) {
      expect(readFileSync(path.join(PLUGIN_DIR, name)).length).toBeLessThanOrEqual(100 * 1024);
    }
  });
});

describe('polling URL', () => {
  test.each([
    [{ vat: 0 }, 'vat=0'],
    [{ vat: '0' }, 'vat=0'],
    [{ vat: 0.21 }, 'vat=0.21'],
    [{ vat: '' }, 'vat=auto'],
    [{}, 'vat=auto']
  ])('vat %j sends %s', async (fields, expected) => {
    const url = await renderPollingUrl({ ...BASE_FIELDS, ...fields });
    expect(`vat=${new URL(url).searchParams.get('vat')}`).toBe(expected);
  });

  test('an existing install keeps its values', async () => {
    await expect(
      renderPollingUrl({ country: 'nl', timeframe: 'next24h', resolution: '60m', markup: 0.09, vat: 0.21 })
    ).resolves.toBe(
      'https://dap.xadi.eu/api/nl/next24h?interval=60m&markup=0.09&variableMarkup=&roundTo=' +
        '&bestPeriodHours=4&vat=0.21'
    );
  });

  test('an install with upper-case values keeps them', async () => {
    const url = await renderPollingUrl({ country: 'NL', timeframe: 'next24h', resolution: '60M', markup: 0, vat: 0 });
    expect(url).toBe(
      'https://dap.xadi.eu/api/NL/next24h?interval=60M&markup=0&variableMarkup=&roundTo=&bestPeriodHours=4&vat=0'
    );
  });

  test.each([
    ['today', '/api/nl/today'],
    ['next24h', '/api/nl/next24h'],
    ['next12', '/api/nl/next/12'],
    ['nextall', '/api/nl/next/48'],
    ['NEXT12', '/api/nl/next/12']
  ])('timeframe %s reaches %s', async (timeframe, pathname) => {
    expect(new URL(await renderPollingUrl({ ...BASE_FIELDS, timeframe })).pathname).toBe(pathname);
  });

  test('passes the new settings', async () => {
    const url = new URL(
      await renderPollingUrl({ ...BASE_FIELDS, variable_markup: 10, round_to: '2', best_period_hours: '6' })
    );
    expect(url.searchParams.get('variableMarkup')).toBe('10');
    expect(url.searchParams.get('roundTo')).toBe('2');
    expect(url.searchParams.get('bestPeriodHours')).toBe('6');
  });

  test('a blank best period length sends 4', async () => {
    const url = new URL(await renderPollingUrl({ ...BASE_FIELDS, best_period_hours: '' }));
    expect(url.searchParams.get('bestPeriodHours')).toBe('4');
  });
});

describe('strings', () => {
  test.each(LANGUAGES)('%s has every string', language => {
    expect(Object.keys(STRINGS[language]).sort()).toEqual([...STRING_KEYS].sort());
    for (const key of STRING_KEYS) {
      expect(STRINGS[language][key].trim()).not.toBe('');
    }
  });

  test('only the supported languages exist', () => {
    expect(Object.keys(STRINGS).sort()).toEqual([...LANGUAGES].sort());
  });

  test('no shown text is undefined in any language', async () => {
    for (const language of LANGUAGES) {
      for (const name of ['nl-today', 'nl-next24h-warnings']) {
        const { chart, elements } = await render('full', fixture(name), { language });
        const shown = [chart.title.text, chart.yAxis.title.text, elements.info.innerHTML].join(' ');
        expect(shown).not.toMatch(/undefined|null|NaN|\{[a-z]+\}/);
      }
      const { elements } = await render('full', { data: [] }, { language });
      expect(elements.info.innerHTML).toBe(STRINGS[language].noPrices);
    }
  });
});

describe('language', () => {
  const yAxisFor = async (fieldValues, locale) => {
    const { chart } = await render('full', fixture('nl-today'), fieldValues, { user: { locale } });
    return chart.yAxis.title.text;
  };

  test.each(['en-GB', 'EN', 'pt', '', undefined])('device locale %s gives English', async locale => {
    await expect(yAxisFor({}, locale)).resolves.toBe(STRINGS.en.yAxis);
  });

  test.each(['nb_NO', 'no', 'nn'])('device locale %s gives Norwegian', async locale => {
    await expect(yAxisFor({}, locale)).resolves.toBe(STRINGS.nb.yAxis);
  });

  test('the language setting beats the device, in either case', async () => {
    await expect(yAxisFor({ language: 'NL' }, 'en')).resolves.toBe(STRINGS.nl.yAxis);
  });

  test.each(['device', 'DEVICE', ''])('language %j follows the device', async language => {
    await expect(yAxisFor({ language }, 'de-DE')).resolves.toBe(STRINGS.de.yAxis);
  });

  test('an unsupported language setting gives English', async () => {
    await expect(yAxisFor({ language: 'pt' }, 'de')).resolves.toBe(STRINGS.en.yAxis);
  });
});

describe.each(LAYOUTS)('layout %s', layout => {
  test('only calls the shared chart with its sizes', () => {
    const source = readFileSync(path.join(PLUGIN_DIR, `${layout}.liquid`), 'utf8');
    const onlyTheCall = /^<script type="text\/javascript">\s*window\.renderDayAheadChart\((\{.*\})\);\s*<\/script>\s*$/;
    const call = source.match(onlyTheCall);
    expect(call).not.toBeNull();
    expect(vm.runInNewContext(`(${call[1]})`)).toEqual(SIZES[layout]);
  });

  test('today titles carry the date in the country timezone', async () => {
    const response = fixture('nl-today');
    const { chart } = await render(layout, response);
    // The first slot is 23:00 UTC the day before, so a UTC date would be wrong here
    expect(chart.title.text).toContain(formatDate('en', 'Europe/Amsterdam', '2026-11-01T12:00:00Z'));
    expect(chart.title.text).not.toMatch(/\(\s*\)\s*$/);
  });

  test('a partial next 24 hours says the hours it has', async () => {
    const response = fixture('nl-next24h-partial');
    const { chart } = await render(layout, response);
    expect(response.info.totalHours).toBe(15);
    expect(chart.title.text).toContain('15');
    expect(chart.title.text).not.toContain('24');
  });

  test('the title and labels do not depend on the merge order', async () => {
    const fields = { language: 'en', country: 'nl', markup: 0.09, timeframe: 'today' };
    const responseWins = await render(layout, fixture('de-today'), fields, { mergeOrder: 'response-wins' });
    const fieldsWin = await render(layout, fixture('de-today'), fields, { mergeOrder: 'fields-win' });
    expect(fieldsWin.chart.title.text).toBe(responseWins.chart.title.text);
    expect(fieldsWin.chart.xAxis.categories).toEqual(responseWins.chart.xAxis.categories);
  });

  test('animation is off on the chart and the series', async () => {
    const { chart } = await render(layout, fixture('nl-next24h'));
    expect(chart.chart.animation).toBe(false);
    expect(chart.series[0].animation).toBe(false);
  });

  test('the chart fits its slot, after the info panel is filled', async () => {
    const { chart, elements } = await render(layout, fixture('nl-next24h'), undefined, { slotHeight: 300 });
    expect(chart.chart.height).toBe(300 - INFO_PANEL_HEIGHT - 10);
    expect(elements.chart.style.height).toBe(`${300 - INFO_PANEL_HEIGHT - 10}px`);
  });

  test('an empty info panel only takes its margin', async () => {
    const response = { ...fixture('nl-next24h'), bestPeriod: null };
    const { chart } = await render(layout, response, undefined, { slotHeight: 300 });
    expect(chart.chart.height).toBe(290);
  });

  test('without a slot the chart uses the layout height', async () => {
    const { chart } = await render(layout, fixture('nl-next24h'));
    expect(chart.chart.height).toBe(SIZES[layout].chartHeight);
  });

  test('a slot too small to hold the panel falls back to the layout height', async () => {
    const { chart } = await render(layout, fixture('nl-next24h'), undefined, { slotHeight: 20 });
    expect(chart.chart.height).toBe(SIZES[layout].chartHeight);
  });

  test('uses the layout text sizes', async () => {
    const { chart, elements } = await render(layout, fixture('nl-next24h'));
    expect(chart.title.style.fontSize).toBe(SIZES[layout].titleSize);
    expect(chart.xAxis.labels.style.fontSize).toBe(SIZES[layout].axisSize);
    expect(chart.yAxis.labels.style.fontSize).toBe(SIZES[layout].axisSize);
    expect(elements.info.style.fontSize).toBe(SIZES[layout].infoSize);
  });

  test('marks exactly the slots of the best period, and names it', async () => {
    const response = fixture('nl-today');
    response.bestPeriod = {
      hours: 4,
      startTime: response.data[2].time,
      endTime: response.data[6].time,
      averagePrice: 0.18234,
      intervals: 4
    };
    const { chart, elements } = await render(layout, response);
    const marked = chart.series[0].data.flatMap((point, i) => (point.color?.pattern ? [i] : []));
    expect(marked).toEqual([2, 3, 4, 5]);
    expect(elements.info.innerHTML).toContain('4');
    expect(elements.info.innerHTML).toContain('02:00 - 06:00');
  });

  test('with no best period nothing is marked and the panel is empty', async () => {
    const { chart, elements } = await render(layout, { ...fixture('nl-next24h'), bestPeriod: null });
    expect(chart.series[0].data.some(point => point.color)).toBe(false);
    expect(elements.info.innerHTML).toBe('');
  });

  test('negative bars keep the best-period pattern and have no colour of their own', async () => {
    const response = fixture('nl-next24h-negative');
    const { chart } = await render(layout, response);
    const points = chart.series[0].data;
    const start = new Date(response.bestPeriod.startTime).getTime();
    const end = new Date(response.bestPeriod.endTime).getTime();
    response.data.forEach((item, i) => {
      const time = new Date(item.time).getTime();
      expect(Boolean(points[i].color?.pattern)).toBe(time >= start && time < end);
    });
    expect(points.some(point => point.y < 0 && point.color?.pattern)).toBe(true);
    expect(chart.plotOptions.column.negativeColor).toBeUndefined();
  });

  test('highcharts chooses the y-axis ticks', async () => {
    const { chart } = await render(layout, fixture('nl-next24h'));
    expect(chart.yAxis.tickInterval).toBeUndefined();
  });

  test.each([
    ['nl-next24h', 24],
    ['nl-today-dst-100', 100]
  ])('the x-axis thins the labels of %s', async (name, points) => {
    const { chart } = await render(layout, fixture(name));
    expect(chart.xAxis.categories).toHaveLength(points);
    expect(chart.xAxis.labels.step).toBe(Math.ceil(points / SIZES[layout].maxLabels));
  });

  test('has no tooltip formatter', async () => {
    const { chart } = await render(layout, fixture('nl-next24h'));
    expect(chart.tooltip?.formatter).toBeUndefined();
  });

  test.each([[{ data: [] }], [{ status: 'success' }]])(
    'no prices in %j shows the message, not a chart',
    async response => {
      const { chart, elements } = await render(layout, response);
      expect(chart).toBeNull();
      expect(elements.info.innerHTML).toContain(STRINGS.en.noPrices);
    }
  );

  test('a rejected setting shows the message from the API', async () => {
    const response = { status: 'error', message: 'Invalid vat. Use a number from 0 to 1.' };
    const { chart, elements } = await render(layout, response);
    expect(chart).toBeNull();
    expect(elements.info.innerHTML).toContain(STRINGS.en.noPrices);
    expect(elements.info.innerHTML).toContain(response.message);
  });

  test('the elements use the append_random ID', async () => {
    const { elements } = await render(layout, fixture('nl-next24h'));
    expect(elements.chart.id).toBe('chart-test');
    expect(elements.info.id).toBe('chart-test-info');
  });

  test('can appear twice on a page, as in a mashup', async () => {
    const { chart } = await render(layout, fixture('nl-next24h'), undefined, { instances: 2 });
    expect(chart).not.toBeNull();
  });
});

describe('chart details', () => {
  test.each([
    ['de', 'de', 'today'],
    ['de', 'de', 'next24h'],
    ['se', 'sv', 'today'],
    ['se', 'sv', 'next24h'],
    ['dk', 'da', 'today'],
    ['dk', 'da', 'next24h']
  ])('%s in %s, %s: title and labels are correct', async (country, language, timeframe) => {
    const response = fixture(`${country}-${timeframe}`);
    const { chart } = await render('full', response, { language });
    const timezone = response.info.timezone;
    expect(chart.xAxis.categories).toEqual(response.data.map(item => formatTime(language, timezone, item.time)));
    if (timeframe === 'today') {
      expect(chart.title.text).toContain(formatDate(language, timezone, response.data[12].time));
    } else {
      expect(chart.title.text).toContain('24');
    }
  });

  test('the DST day repeats the extra hour and dates the title correctly', async () => {
    const { chart } = await render('full', fixture('nl-today-dst-100'));
    expect(chart.xAxis.categories.filter(label => label === '02:00')).toHaveLength(2);
    expect(chart.xAxis.categories[0]).toBe('00:00');
    expect(chart.xAxis.categories[99]).toBe('23:45');
    expect(chart.title.text).toContain(formatDate('en', 'Europe/Amsterdam', '2026-10-25T12:00:00Z'));
  });

  test('CH at 15M comes back hourly and still draws', async () => {
    const { chart } = await render('full', fixture('ch-next24h-15m'));
    expect(chart.series[0].data).toHaveLength(24);
    expect(chart.xAxis.labels.step).toBe(1);
  });

  test.each([
    ['nl', '€0,25'],
    ['en', '€0.25']
  ])('y-axis numbers follow the language: %s shows %s', async (language, expected) => {
    const { chart } = await render('full', fixture('nl-next24h'), { language });
    expect(chart.yAxis.labels.formatter.call({ value: 0.25 })).toBe(expected);
  });

  test('shared.liquid has no chartkick, no negative colour and pinned Highcharts', () => {
    expect(SHARED_SOURCE).not.toMatch(/chartkick/i);
    expect(SHARED_SOURCE).not.toContain('negativeColor');
    const sources = [...SHARED_SOURCE.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map(match => match[1]);
    expect(sources).toEqual([
      'https://trmnl.com/js/highcharts/12.3.0/highcharts.js',
      'https://trmnl.com/js/highcharts/12.3.0/pattern-fill.js'
    ]);
  });

  test('the plugin never reads the locale-dependent fields', () => {
    expect(SHARED_SOURCE).not.toMatch(/localTime|item\.hour/);
  });

  test.each([
    ['fallback_source: stekker', 'warnFallbackSource'],
    [
      'fallback_source: stekker_quarterly (HH:00 quarters may carry stale hourly clearing prices)',
      'warnFallbackSource'
    ],
    ['stale_data: upstream refresh failed', 'warnStaleData'],
    ['incomplete_data: prices missing for part of today', 'warnIncompleteData'],
    ['foo: bar', 'warnGeneric']
  ])('warning %s shows a translated note', async (warning, key) => {
    const response = { ...fixture('nl-next24h'), warnings: [warning] };
    for (const language of ['en', 'nl']) {
      const { elements } = await render('full', response, { language });
      expect(elements.info.innerHTML).toContain(STRINGS[language][key]);
      expect(elements.info.innerHTML).not.toContain(warning.split(':')[0]);
    }
  });

  test('every warning in a response gets a note', async () => {
    const { elements } = await render('full', fixture('nl-next24h-warnings'));
    for (const key of ['warnFallbackSource', 'warnStaleData', 'warnIncompleteData']) {
      expect(elements.info.innerHTML).toContain(STRINGS.en[key]);
    }
  });

  test('two unknown warnings show the generic note once', async () => {
    const response = { ...fixture('nl-next24h'), warnings: ['foo: bar', 'baz'] };
    const { elements } = await render('full', response);
    expect(elements.info.innerHTML.split(STRINGS.en.warnGeneric)).toHaveLength(2);
  });

  test('warnings show without a best period', async () => {
    const response = { ...fixture('nl-next24h-warnings'), bestPeriod: null };
    const { elements } = await render('full', response);
    expect(elements.info.innerHTML).toContain(STRINGS.en.warnStaleData);
  });

  test('an API message cannot break out of the script or the panel', async () => {
    const message = "Invalid interval '</script><b>x'. Valid values: 60M, 15M.";
    const { elements } = await render('full', { status: 'error', message });
    expect(elements.info.innerHTML).toContain('&lt;/script&gt;&lt;b&gt;x');
    expect(elements.info.innerHTML).not.toContain('<b>');
  });

  test.each([
    [2, '0.23'],
    ['2', '0.23'],
    ['', '0.23126'],
    [undefined, '0.23126']
  ])('round_to %j shows the average as %s', async (roundTo, expected) => {
    const { elements } = await render('full', fixture('nl-today'), { language: 'en', round_to: roundTo });
    expect(elements.info.innerHTML).toMatch(new RegExp(`€${expected.replace('.', '\\.')}\\D`));
  });

  test('prices as text use the language decimal separator', async () => {
    const { elements } = await render('full', fixture('nl-today'), { language: 'nl' });
    expect(elements.info.innerHTML).toContain('0,23126');
  });
});

test('the harness can run a response without info', async () => {
  const response = {
    data: [
      { time: '2026-11-01T00:00:00.000Z', price: 0.1 },
      { time: '2026-11-01T01:00:00.000Z', price: 0.08 }
    ]
  };
  const { chart } = await render('full', response, {});
  expect(chart.series[0].data).toHaveLength(2);
});
