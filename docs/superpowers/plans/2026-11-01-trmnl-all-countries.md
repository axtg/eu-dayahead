# TRMNL Plugin: All Countries, All Options Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `bestPeriodHours` API parameter, and make the TRMNL plugin work for all 9 countries with every price option and device-language text, without changing an existing user's prices.

**Architecture:** The API calculates the best period per request from the prices it is already returning. The plugin moves to one render function in `shared.liquid`, and each layout only passes its sizes. Liquid and chart logic are tested in Jest by rendering templates with `liquidjs` and running the resulting script in `vm` with a stubbed Highcharts.

**Tech Stack:** Express, Jest, supertest, TRMNL Liquid, Highcharts. New dev dependencies: `liquidjs`, `js-yaml`.

**Spec:** `docs/superpowers/specs/2026-11-01-trmnl-all-countries-design.md`

## Global Constraints

- Keep the existing field keys (`timeframe`, `country`, `resolution`, `markup`, `vat`) and option values.
- NL stays the default country.
- `bestPeriodHours`: whole number from 1 to 24, additive; responses without it are unchanged.
- Never parse `localTime` or `hour`. Derive times from `time` and `info.timezone`.
- Read `info.timezone` and `info.resolutionMinutes`, and take settings from `trmnl.plugin_settings.custom_fields_values` when rendering, because `country` and `markup` are also response keys.
- Leave `framework_version` and `refresh_interval` unchanged. Each plugin file is at most 100 KB.
- Code style: single quotes, semicolons, 2-space indent, no trailing commas, max 120 columns.
- Only Xander can touch TRMNL. No task updates the master recipe.
- Every select option value in `settings.yml` is quoted. TRMNL's Ruby YAML reads an unquoted `NO` or `no` as boolean `false`, and js-yaml doesn't, so Jest can't see this without a raw-text test.
- Country option values are lower case and labelled (`- Netherlands: 'nl'`), NL first. Most installs already hold `nl`, and a value that doesn't match pre-selects the wrong country on the user's next save.

## Review Focus

Each has a test in the task that owns the code.

1. An install holding `vat` 0, as a number or the string `"0"`, must send `vat=0`, never `vat=auto` (Task 4).
2. An existing install with only the old fields set must produce a valid URL with its old values (Task 4).
3. Stored select values in either case (`NL`/`nl`, `60M`/`60m`, `NL` as `language`) must behave the same (Task 4).
4. A response with no `data` key (an API error passed through) must show the "no prices" text, not throw (Task 4).
5. Locale forms such as `en-GB`, `nb_NO`, `NL`, `pt`, blank and missing must resolve to a supported language or English (Task 4).

Jest can't see two risks, so they're rollout checks instead: TRMNL's form matching stored values to options, and the real YAML and Liquid engines.

---

### Task 1: Baseline commit and repo hygiene

Commit the plugin as it is first, so later diffs show real changes.

**Files:**
- Delete: `integrations/trmnl-70055-energy_day_ahead_prices/*:Zone.Identifier`
- Modify: `.gitignore`, `.dockerignore`, `CLAUDE.md`
- Add: `integrations/`

**Interfaces:** Produces the baseline commit that Task 3 builds on.

- [ ] **Step 1: Delete the `*:Zone.Identifier` files**

Run: `find integrations -name '*:Zone.Identifier' -delete && find integrations -type f | wc -l`
Expected: `6`

- [ ] **Step 2: Add `*:Zone.Identifier` to `.gitignore` and `integrations` to `.dockerignore`**

- [ ] **Step 3: Correct request flow item 4 in `CLAUDE.md`**

Replace "`/next24h` and `/next/:hours` also return 503 if the cached prices end before the requested window." with "`/next24h` and `/next/:hours` return the prices available in the window, with `info.actualHours` on `/next/:hours`, and a 503 only if none fall in it."

- [ ] **Step 4: Verify**

Run: `npm run lint && npm test -- tests/apiDocs.test.js`
Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add .gitignore .dockerignore CLAUDE.md integrations
git commit -m "chore: add the TRMNL plugin as it is published"
```

### Task 2: `bestPeriodHours` in the API

**Files:**
- Modify: `utils/helpers.js`, `routes/countries.js`, `docs/openapi.yaml`, `readme.md`, the parameter table in `public/index.html`
- Test: `tests/helpers.test.js`, `tests/inputValidation.test.js`, new `tests/bestPeriod.test.js`

**Interfaces:**
- Produces, exported from `utils/helpers.js`:
  - `parseBestPeriodHours(query) -> number | undefined`
  - `findBestPeriod(prices, hours, resolutionMinutes, roundTo) -> { hours, startTime, endTime, averagePrice, intervals } | null`
- `buildCountryResponse` accepts `bestPeriod` in `additionalInfo` and sets top-level `response.bestPeriod` only when it is not `undefined`. It must not end up in `info`.
- Task 4 relies on the response shape above.

- [ ] **Step 1: Write the failing tests**

Add to `INVALID_QUERIES` in `tests/inputValidation.test.js`: `bestPeriodHours=0`, `bestPeriodHours=25`, `bestPeriodHours=2.5`, `bestPeriodHours=abc`, `bestPeriodHours=4&bestPeriodHours=5`.

In `tests/helpers.test.js`, using a small helper that builds `{ time, price }` slots:

```js
test('finds the cheapest consecutive window', () => {
  const prices = slots('2026-11-02T00:00:00Z', 60, [5, 5, 1, 1, 5, 5]);
  expect(findBestPeriod(prices, 2, 60, 5)).toEqual({
    hours: 2,
    startTime: '2026-11-02T02:00:00.000Z',
    endTime: '2026-11-02T04:00:00.000Z',
    averagePrice: 1,
    intervals: 2
  });
});

test('hours become slots from the actual resolution', () => {
  expect(findBestPeriod(slots(START, 15, Array(8).fill(1)), 2, 15, 5).intervals).toBe(8);
  expect(findBestPeriod(slots(START, 60, Array(8).fill(1)), 2, 60, 5).intervals).toBe(2);
});

test('the earliest wins a tie', () => {
  expect(findBestPeriod(slots(START, 60, [1, 1, 9, 1, 1]), 2, 60, 5).startTime).toBe(iso(START));
});

test('the earliest wins a tie despite floating-point averages', () => {
  const prices = slots(START, 60, [0.1, 0.2, 0.3, 0.3, 0.2, 0.1]);
  expect(findBestPeriod(prices, 3, 60, 5).startTime).toBe(iso(START));
});

test('a window across a gap does not count', () => {
  const prices = [...slots('2026-11-02T00:00:00Z', 60, [9, 1]), ...slots('2026-11-02T03:00:00Z', 60, [1, 9])];
  expect(findBestPeriod(prices, 2, 60, 5).startTime).toBe('2026-11-02T00:00:00.000Z');
});

test('returns null when no window fits', () => {
  expect(findBestPeriod(slots(START, 60, [1, 1, 1]), 4, 60, 5)).toBeNull();
  expect(findBestPeriod([], 1, 60, 5)).toBeNull();
});

test('a window across the autumn clock change is consecutive', () => {
  const prices = slots('2026-10-24T22:00:00Z', 15, Array(100).fill(1)); // Amsterdam, 100 quarter-hours that day
  expect(findBestPeriod(prices, 25, 15, 5).intervals).toBe(100);
});

test('rounds the average to roundTo', () => {
  expect(findBestPeriod(slots(START, 60, [0.1, 0.2]), 2, 60, 2).averagePrice).toBe(0.15);
});
```

`parseBestPeriodHours`: `{}` and `{ bestPeriodHours: '' }` give `undefined`; `{ bestPeriodHours: '4' }` gives `4`.

Route tests in `tests/bestPeriod.test.js`, using the `loadApp()` pattern at `tests/errorHandling.test.js:40-60`, for `/api/nl/today`, `/next24h` and `/next/6`: with `bestPeriodHours=2` the body has `bestPeriod.hours === 2`, the `intervals` for that response's resolution, and a range inside `data`; without it the body has no `bestPeriod` key; `bestPeriodHours=` behaves as absent; a request for more hours than `data` covers gives `bestPeriod: null`; `info` never has a `bestPeriod` key. For hourly-only data requested at `15M`, as CH returns, `bestPeriodHours=2` gives `intervals: 2`.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- tests/helpers.test.js tests/inputValidation.test.js tests/bestPeriod.test.js`
Expected: FAIL, `findBestPeriod is not a function`, and the invalid queries return 200.

- [ ] **Step 3: Implement in `utils/helpers.js`**

`parseBestPeriodHours` follows `parseRoundTo`: `parseNumberParam(query, 'bestPeriodHours', 1, 24)`, then reject non-integers with `invalidParam`.

`findBestPeriod`: slots are `hours * 60 / resolutionMinutes`. Slide over the prices, skipping any window where last start minus first start isn't `(slots - 1) * resolutionMinutes` minutes. Keep a window only if its average is lower by more than `1e-9`, so the earliest wins ties despite floating-point drift. Compute each window's average from its own values, not a running sum. `endTime` is the last slot's start plus `resolutionMinutes`. Round the average with the same method `StekkerAPI.applyMarkup` uses.

- [ ] **Step 4: Use it in `routes/countries.js`**

In `/today` and `sendNextHours`, parse next to `parseIntervalOption`, so bad input returns 400 before any upstream call. Name the parsed value `bestPeriodHours`, because `sendNextHours` already has `hours` for the window length. When it isn't `undefined`, pass `bestPeriod: findBestPeriod(enrichedPrices, bestPeriodHours, result.resolutionMinutes, markupOptions.roundTo)` to `buildCountryResponse`.

- [ ] **Step 5: Document it**

In `docs/openapi.yaml`, add a `BestPeriodHours` parameter (integer, 1 to 24, no default), reference it on the three country routes, and add a `nullable: true` `bestPeriod` property with the five fields to both `PricesResponse` and `Next24HoursResponse`. Add a row to the readme's parameter list and to the parameter table in `public/index.html`, using only existing Tailwind classes.

- [ ] **Step 6: Verify**

Run: `npm test -- tests/helpers.test.js tests/inputValidation.test.js tests/bestPeriod.test.js tests/priceCache.test.js tests/apiDocs.test.js && npm run lint && npm run validate-api`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add utils/helpers.js routes/countries.js docs/openapi.yaml tests readme.md public/index.html
git commit -m "feat: return the cheapest period for a requested number of hours"
```

### Task 3: Test harness and the settings-only update

This commit is what Xander imports as the first master update (spec, rollout step 2). Its polling URL and layouts must be identical to Task 1's.

**Files:**
- Modify: `package.json`, `package-lock.json`, `integrations/trmnl-70055-energy_day_ahead_prices/settings.yml`
- Create: `tests/trmnl/harness.js`
- Test: `tests/trmnl.test.js`

**Interfaces:**
- Produces, from `tests/trmnl/harness.js`:
  - `loadSettings() -> object` (parsed `settings.yml`)
  - `renderPollingUrl(fieldValues) -> Promise<string>`
  - `renderLayout(layoutName, { response, fieldValues, user, mergeOrder, slotHeight }) -> Promise<{ chart, elements, errors }>`: renders `shared.liquid` plus the layout, then runs each inline script in `vm` and returns the captured chart config. `elements.chart` and `elements.info` are the elements with IDs `<chart_id>` and `<chart_id>-info`, each exposing `innerHTML` and style. `chart` is `null` if `Highcharts.chart` wasn't called. `errors` holds anything thrown.
- The stubs: `Highcharts.chart`; `window`, including `addEventListener`; and `document.getElementById`, which returns `null` for any ID not in the rendered HTML. Elements have `closest()`, returning a stub with `clientHeight: slotHeight` when `slotHeight` is set and `null` otherwise, plus `clientHeight` and `offsetHeight`. For `window.renderDayAheadChart` to exist, `shared.liquid`'s scripts run in the same `vm` context as the layout's.
- The harness registers `append_random` with liquidjs, returning the input plus a fixed suffix, and `json` as `v => JSON.stringify(v ?? null)`, which is what TRMNL's `JSON.generate` gives. liquidjs would otherwise render a missing value as an empty string, a syntax error that TRMNL wouldn't have.
- Liquid variables are the response keys and the field values, with the `trmnl` object holding `trmnl.plugin_settings.custom_fields_values` and `trmnl.user.locale`. `mergeOrder` is `'response-wins'` (default) or `'fields-win'`, because TRMNL's docs don't say which wins for `country` and `markup`.

- [ ] **Step 1: Install the dev dependencies**

Run: `npm install --save-dev liquidjs js-yaml`
Expected: `package.json` and `package-lock.json` change, under `devDependencies` only.

- [ ] **Step 2: Write the failing tests**

```js
const OLD_URL =
  'https://dap.xadi.eu/api/{{ country }}/{{ timeframe }}?interval={{ resolution }}&markup={{ markup }}&vat={{ vat }}';

test('the polling URL is unchanged', () => expect(loadSettings().polling_url).toBe(OLD_URL));

test('adds the new fields as optional', () => {
  for (const key of ['variable_markup', 'round_to', 'best_period_hours', 'language']) {
    expect(field(key).optional).toBe(true);
  }
});

test('vat is optional with no default', () => {
  expect(field('vat').optional).toBe(true);
  expect(field('vat')).not.toHaveProperty('default');
});

test('existing options stay', () => {
  expect(optionValues('country')).toEqual(['DE', 'NL']);
  expect(optionValues('timeframe')).toEqual(['next24h', 'today']);
  expect(optionValues('resolution')).toEqual(['15M', '60M']);
});

test('language options', () => {
  expect(optionValues('language')).toEqual(['device', 'en', 'nl', 'de', 'fr', 'da', 'nb', 'sv']);
});

test('numeric selects use labelled, quoted values', () => {
  expect(optionValues('round_to')).toEqual(['2', '3', '4', '5']);
  expect(optionValues('best_period_hours')).toEqual(['1', '2', '3', '4', '6', '8']);
});

test('the harness can run the current layouts', async () => {
  const { chart, errors } = await renderLayout('full', { response: fixtureResponse, fieldValues: {}, user: { locale: 'nl' } });
  expect(errors).toEqual([]);
  expect(chart.series[0].data).toHaveLength(fixtureResponse.data.length);
});

test('an install with no vat still renders vat= in this update', async () => {
  await expect(renderPollingUrl({ country: 'nl', timeframe: 'next24h', resolution: '60m', markup: 0 }))
    .resolves.toBe('https://dap.xadi.eu/api/nl/next24h?interval=60m&markup=0&vat=');
});
```

`optionValues` must handle both forms of select option: `- NL` and `- Netherlands: NL`.

- [ ] **Step 3: Run to verify they fail**

Run: `npm test -- tests/trmnl.test.js`
Expected: FAIL, first with a missing `tests/trmnl/harness.js`. Create an empty module exporting the three functions, and re-run for failures on the new fields and on `vat`'s default.

- [ ] **Step 4: Implement the harness and edit `settings.yml`**

Add `variable_markup` (number, step 0.01), `round_to` (select: `- 2 decimals: '2'` and so on), `best_period_hours` (select: `- 4 hours: '4'` and so on, `default: '4'`) and `language` (select from the spec's table, `default: device`), all `optional: true`. The docs only show numeric select values in labelled form. On `vat`, remove `default: 0`, add `optional: true`, and set `step: 0.001` so CH's 0.081 can be entered. Fix the markup help text: EUR/kWh, "0.12 = 12 cents". The `vat` help text can't yet promise the country rate, because this update doesn't send `auto`.

- [ ] **Step 5: Verify, and that the layouts didn't change**

Run: `npm test -- tests/trmnl.test.js && git diff --stat -- 'integrations/**/*.liquid'`
Expected: tests pass; the diff lists no `.liquid` files.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tests/trmnl tests/trmnl.test.js integrations
git commit -m "feat(trmnl): add the new settings without using them yet"
```

Note this commit's SHA in the handoff; Task 5 builds the first import from it.

### Task 4: Full settings, polling URL and shared chart

**Files:**
- Modify: `integrations/trmnl-70055-energy_day_ahead_prices/settings.yml`, `shared.liquid`, `full.liquid`, `half_horizontal.liquid`, `half_vertical.liquid`, `quadrant.liquid`, and `tests/trmnl/harness.js` if needed
- Test: `tests/trmnl.test.js`, with response fixtures saved from the live API in `tests/fixtures/trmnl/`

**Interfaces:**
- Consumes: the harness from Task 3 and the `bestPeriod` shape from Task 2.
- Produces: `shared.liquid` defines `window.renderDayAheadChart(sizes)`, called immediately by each layout with `{ chartHeight, titleSize, axisSize, infoSize, maxLabels }`.

Starting sizes:

| Layout | chartHeight | titleSize | axisSize | infoSize | maxLabels |
|--------|-------------|-----------|----------|----------|-----------|
| `full` | 400 | 18px | 13px | 16px | 24 |
| `half_horizontal` | 215 | 14px | 13px | 12px | 24 |
| `half_vertical` | 400 | 16px | 10px | 12px | 12 |
| `quadrant` | 215 | 14px | 13px | 12px | 12 |

- [ ] **Step 1: Save fixtures from the live API**

Save to `tests/fixtures/trmnl/`, each requested with `bestPeriodHours=4`: `nl` `today` and `next24h`; `de`, `se` and `dk` `next24h` and `today`; `ch` `next24h` at `15M`. Build these by editing a saved response, updating `info.totalIntervals` and `info.totalHours` to match: a partial next-24h of 15 hours (truncate `data`), negative prices, warnings, and a DST day with 100 quarter-hours.

- [ ] **Step 2: Write the failing polling URL tests**

The base is `https://dap.xadi.eu/api`. Replace the Task 3 URL and option tests.

```js
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
    'https://dap.xadi.eu/api/nl/next24h?interval=60m&markup=0.09&variableMarkup=&roundTo=&bestPeriodHours=4&vat=0.21'
  );
});

test.each([
  ['today', '/api/nl/today'],
  ['next24h', '/api/nl/next24h'],
  ['next12', '/api/nl/next/12'],
  ['nextall', '/api/nl/next/48'],
  ['NEXT12', '/api/nl/next/12']
])('timeframe %s reaches %s', async (timeframe, path) => {
  expect(new URL(await renderPollingUrl({ ...BASE_FIELDS, timeframe })).pathname).toBe(path);
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
});

test('timeframe options', () => {
  expect(optionValues('timeframe')).toEqual(['today', 'next12', 'next24h', 'nextall']);
  expect(field('timeframe').default).toBe('next24h');
});
```

- [ ] **Step 3: Write the failing render tests, across all four layouts where marked**

Expected values, with an `nl` fixture and `language: 'en'` unless stated:

- **Strings:** all 7 languages have every string key, so a missing translation can't show `undefined`.
- **Language:** `en-GB`, `EN`, `pt`, blank and missing give the English y-axis title. `nb_NO` and `no` give Norwegian. Setting `language: 'NL'` on a device set to `en` gives Dutch. `language: 'device'` follows the device.
- **Title (all layouts):** `today` includes the date formatted in `info.timezone`, and never ends in `()`. For a partial next-24h fixture with 15 hours, the title says 15 hours, read from `info.totalHours`.
- **Date formats:** the `de`, `se` and `dk` fixtures produce a correct title and category labels. Compute expected dates with `Intl`, not literal strings, because ICU versions differ between Node releases.
- **Merge order:** the title and labels are the same under both `mergeOrder` values.
- **Animation:** `series[0].animation` and `chart.animation` are `false`.
- **Height:** with `slotHeight: 300` the chart height is 300 minus the info panel's height and margin; without it, `chartHeight`.
- **Best period:** with `bestPeriod` of 4 hours from 02:00 to 06:00 local, `elements.info.innerHTML` contains `4` and `02:00 - 06:00`. Exactly the slots from `startTime` up to, but excluding, `endTime` have a pattern colour. With `bestPeriod: null` the info panel is empty.
- **Y-axis:** `tickInterval` is undefined.
- **X-axis:** `labels.step` is `Math.ceil(points / maxLabels)`, in all layouts.
- **Removed:** no `tooltip` formatter, no `negativeColor`, and no `chartkick` in `shared.liquid`.
- **Highcharts:** script URLs include an exact version.
- **Warnings:** `fallback_source: stekker` gives a translated note. An unknown `foo: bar` gives the generic note.
- **No prices:** `{ data: [] }` and a response with no `data` key both show the "no prices" text, `Highcharts.chart` isn't called, and `errors` is empty.
- **Bad setting:** `{ status: 'error', message: 'Invalid vat...' }` shows that message.
- **`round_to`:** `round_to: 2` shows the average with 2 decimals. Blank shows 5.
- **Chart ID:** the chart element's ID is the `append_random` output.

- [ ] **Step 4: Run to verify they fail**

Run: `npm test -- tests/trmnl.test.js`
Expected: FAIL on the new URL, the options and every render assertion.

- [ ] **Step 5: Update `settings.yml`**

- Polling URL, exactly this line. It must be double-quoted because `default: 4` contains a colon and space, and single quotes would collide with `vat == ''`:

```yaml
polling_url: "https://dap.xadi.eu/api/{{ country }}/{% assign tf = timeframe | downcase %}{% if tf == 'next12' %}next/12{% elsif tf == 'nextall' %}next/48{% else %}{{ tf }}{% endif %}?interval={{ resolution }}&markup={{ markup }}&variableMarkup={{ variable_markup }}&roundTo={{ round_to }}&bestPeriodHours={{ best_period_hours | default: 4 }}&vat={% if vat == nil or vat == '' %}auto{% else %}{{ vat }}{% endif %}"
```

- All 9 countries, labelled by name with quoted lower-case values, NL first: `- Netherlands: 'nl'`, `- Norway: 'no'`, with `default: 'nl'`. Keep `resolution` as plain options.
- The new timeframe options with labels: `- Today: 'today'`, `- Next 12 hours: 'next12'`, `- Next 24 hours: 'next24h'`, `- All published prices: 'nextall'`.
- `vat` help text: blank uses the country's rate; "0.21, not 21".
- `name: EU Energy Day Ahead Prices`, and the author bio without "NL".
- Step for `markup`: 0.001.

- [ ] **Step 6: Implement `shared.liquid` and the layouts**

`shared.liquid` contains:

- Pinned scripts from TRMNL: `https://trmnl.com/js/highcharts/12.3.0/highcharts.js` and `https://trmnl.com/js/highcharts/12.3.0/pattern-fill.js`.
- `{% assign chart_id = 'chart' | append_random %}`, with a chart `div` of ID `{{ chart_id }}` and an info panel of ID `{{ chart_id }}-info`. Both live in `shared.liquid`.
- `{% for item in data %}`, emitting only `time` and `price`. `info`, `bestPeriod`, `warnings` and `message` are embedded as `{{ warnings | json }}` and so on, with JS that accepts `null` for any of them. Never add `| default: '[]'` before `json`, because that produces a string.
- `STRINGS` for `en`, `nl`, `de`, `fr`, `da`, `nb`, `sv`, with keys `titleToday`, `titleNext`, `yAxis`, `bestPeriod`, `noPrices`, `warnFallbackSource`, `warnStaleData`, `warnIncompleteData`, `warnGeneric`. Check the warning codes with `grep -n "warnings" utils/helpers.js` and add a key for any others.
- `resolveLanguage(setting, locale)`: setting wins unless blank or `device`; first two letters, lower case; `nn` and `no` become `nb`; unsupported becomes `en`.
- `Intl.DateTimeFormat` with the resolved language, `info.timezone` and `hourCycle: 'h23'` for all times and dates.
- `window.renderDayAheadChart(sizes)`, with the Chart behaviour section of the spec, and animation off on both `chart` and `series`.

For height, fill the info panel first. Then use `el.closest('.view')?.clientHeight` minus the panel's `offsetHeight` and its 10px margin when that is positive, otherwise `sizes.chartHeight`.

Each layout file contains only:

```liquid
<script type="text/javascript">
  window.renderDayAheadChart({ chartHeight: 400, titleSize: '18px', axisSize: '13px', infoSize: '16px', maxLabels: 24 });
</script>
```

- [ ] **Step 7: Verify**

Run: `npm test -- tests/trmnl.test.js && npm run lint`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add integrations tests/trmnl.test.js tests/fixtures/trmnl
git commit -m "feat(trmnl): support all countries, options and device language"
```

### Task 5: Visual check and import packages

Jest stubs Highcharts, so this is what checks the chart itself.

**Files:**
- Create: `tests/trmnl/preview.js`
- Modify: `docs/superpowers/specs/2026-11-01-trmnl-all-countries-design.md` only if a check contradicts it

**Interfaces:**
- Consumes: `renderLayout`'s Liquid step from Task 3. Split out `renderHtml(layoutName, options) -> Promise<string>` if needed.
- Produces: HTML pages, screenshots and two ZIP files in the session scratchpad.

- [ ] **Step 1: Write `tests/trmnl/preview.js`**

Usage: `node tests/trmnl/preview.js <outDir>`. It writes one HTML page per case in the spec's Verification matrix, using live API responses where possible and the Task 4 fixtures for the rest. Each page wraps the output in `<div class="view view--<layout>">` at the slot's size inside an 800x480 page, so the container-height path runs rather than the fallback.

- [ ] **Step 2: Screenshot and review with Playwright**

Check all 4 layouts for the `nl`, `de` and `ch` cases, plus negative prices, 15M, warnings and empty data. Use grayscale or a threshold to approximate 1-bit. Fix anything clipped, overlapping or unreadable, then re-run `npm test -- tests/trmnl.test.js`. Commit the preview script, and any fixes:

```bash
git add integrations tests/trmnl
git commit -m "test(trmnl): add a preview for checking the rendered chart"
```

- [ ] **Step 3: Verify the whole repo**

Run: `npm test && npm run lint && npm run validate-api`
Expected: all pass. `tests/api.test.js` depends on Stekker being reachable; report any failure there rather than skipping it.

- [ ] **Step 4: Build the two import packages**

```bash
cd integrations/trmnl-70055-energy_day_ahead_prices
git archive --format=zip -o <scratchpad>/trmnl-step2-full.zip HEAD .
```

`trmnl-step1-settings-only.zip` is a5930fc plus one change, because that commit predates the `round_to` default: `git archive a5930fc` into a temporary directory, change only `round_to` in its `settings.yml` (`default: '5'`, 5 decimals first), and zip those 6 files at the top level. The polling URL and `.liquid` files stay identical to a5930fc.

Run: `unzip -l <scratchpad>/trmnl-step2-full.zip`
Expected: `settings.yml`, `shared.liquid` and 4 layouts at the top level, and no `Zone.Identifier` files.

- [ ] **Step 5: Hand over**

Report the branch, the two ZIP paths, what was and wasn't checked, and the rollout checklist below. Don't merge: merging ships the API change to production.

## Rollout (Xander, after the branch is reviewed)

From the spec's Rollout section. The clone in step 2 needs the API change live.

1. Merge the API change, then confirm: `curl 'https://dap.xadi.eu/api/nl/next24h?bestPeriodHours=4'` returns `bestPeriod`.
2. Export the current master. `settings.yml` contains `id: 70055`, so confirm importing as a clone can't overwrite the master. Import `trmnl-step2-full.zip` as a clone. Use Parse and a real fetch for each timeframe, including `next/12` and `next/48`, and for **Norway**, which must request `/api/no/...`, not `/api/false/...`. Check `{% if %}` and the `json` filter work. **Check saving:** on a fresh install of the clone, don't touch Decimals or Language, save, and confirm `roundTo=5`, `language` stays `device`, and nothing else moved. Preview the original device first, then TRMNL X and a Kindle. Stop if conditionals don't work in the polling URL. TRMNL's `POST /api/markup` renders with its real filters, and `GET /api/plugin_settings/{id}/merge_variables` may answer whether `country` comes from the form or the response.
3. If TRMNL allows it, test an unlisted copy with its own install, as in the spec. **Check the form:** with an install holding `nl`, apply the full version, open the settings, confirm every select pre-selects its stored value, not only country (logs show `60m` stored against plain `60M` options), save, and confirm the URL is unchanged. Repeat with `NL` if you can create one. If a select shows the wrong value, stop before step 7: anyone saving their settings would change it.
4. Re-run the baseline log query. Install test instances with `vat` at 0, at 0.21 and at its default.
5. Import `trmnl-step1-settings-only.zip` into the master.
6. After at least one refresh cycle, compare the logs against the baseline and read the test instances' values. Stop if any `vat=` is now blank.
7. Import `trmnl-step2-full.zip` into the master.
8. Check the logs again: no new 4xx or 5xx, and no unexpected `vat=auto`.
