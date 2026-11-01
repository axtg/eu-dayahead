# TRMNL plugin: all countries, all options, device language

Date: 2026-11-01
Status: awaiting approval
Plugin: `integrations/trmnl-70055-energy_day_ahead_prices/` (TRMNL recipe 70055)

## Intent

The plugin shows day-ahead electricity prices on a TRMNL e-ink screen. Xander uses it, and TRMNL reports 39
other users. It is built for NL and hardcoded in Dutch, while the API serves 9 countries and more options than
the plugin exposes.

Anyone in a supported country should be able to install it, set their country, tax and supplier markup, and get a
correct chart in their own language. It also has display bugs that this work fixes, some of which already affect
DE users.

## Goals

From Xander:

- All 9 countries (NL, DE, BE, FR, AT, CH, DK, NO, SE), with NL as the default so current users keep being served.
- Every price option the API offers can be set: tax rate, markup, timeframe, resolution.
- Text follows the device language, with an optional override.
- The best-period length is a parameter, in both the API and the plugin.

Added by the review (fix these, see "Chart behaviour"):

- Correct best-period label and end time, title, date and markup help text.
- A readable y-axis, visible warnings and an empty state.
- One copy of the chart code rather than four.

## Non-goals

- **Supplier presets (`/api/providers/...`).** Xander asked for "all options"; this is the one exception, and it
  is a design call Xander can overrule. They cover only some countries, their prices are hardcoded, and their responses
  differ in shape. A markup the user enters is more accurate.
- **Currency switching.** All 9 countries return `currency: 'EUR'` (see the comment in `config/countries.js`).
- **Other API changes.** `bestPeriodHours` (below) is the only one. Supplier routes don't get it.
- **Turning the best period off.** Nobody asked for it.

## Anti-goals

These count as failure even if the plugin otherwise works:

- An existing user's prices change because of this update.
- A broken update reaches all installs. TRMNL pushes recipe updates to installed copies automatically, so nothing
  goes to the master recipe before the clone checks in "Rollout" pass.

## Constraints

- Plugin format: `settings.yml` plus `shared.liquid`, `full.liquid`, `half_horizontal.liquid`, `half_vertical.liquid`
  and `quadrant.liquid`. Each file is at most 100 KB.
- `shared.liquid` is prepended to each layout, so it can define a JS function and Liquid variables that the layout
  then uses. It cannot read variables a layout assigns, because those come after it.
- Screens: 800x480 on the original device, 1-bit or 2-bit. TRMNL X is 1872x1404. Animations must be off, or the
  screenshot may capture a partly drawn chart.
- Keep the existing field keys (`timeframe`, `country`, `resolution`, `markup`, `vat`) and option values.
- Merging to this repo does not ship the plugin. Xander imports it into TRMNL separately.

## Settings

| Key | Type | Options | Default | Notes |
|-----|------|---------|---------|-------|
| `country` | select | all 9, labelled by name, NL first, quoted lower-case values (`- Netherlands: 'nl'`, `- Norway: 'no'`) | `nl` | See "Select values" below |
| `timeframe` | select | Today (`today`), Next 12 hours (`next12`), Next 24 hours (`next24h`), All published prices (`nextall`) | `next24h` | see URL below |
| `resolution` | select | `60M`, `15M` | `60M` | CH always returns hourly |
| `markup` | number | | `0` | EUR/kWh. Help text: "0.12 = 12 cents". Step 0.001 |
| `variable_markup` | number, optional | | blank | Percent. API: -100 to 1000 |
| `vat` | number, optional | | blank | Blank = the country's rate. 0.21 = 21%. Help text must say both |
| `round_to` | select, optional | labelled: 2, 3, 4, 5 decimals (`'2'` etc.) | blank | Blank = API default of 5 |
| `best_period_hours` | select, optional | labelled: 1, 2, 3, 4, 6, 8 hours (`'4'` etc.) | `4` | Blank = 4, today's behaviour |
| `language` | select, optional | Device language (`device`), English (`en`), Nederlands (`nl`), Deutsch (`de`), Français (`fr`), Dansk (`da`), Norsk (`nb`), Svenska (`sv`) | `device` | |

Also change `name` to "EU Energy Day Ahead Prices" and remove "NL" from the author bio. These are design calls.

### VAT: why one field

The chat described a separate "country rate / own rate" choice. This design uses the existing `vat` field instead,
with blank meaning the country's rate. A new mode field would need a default. If TRMNL applies that default to
existing installs, everyone with a custom rate would silently move to the country rate.

The form marks `vat` as required with a default of 0 today, so existing installs should already hold a number and
keep exactly the prices they have. The logs back this up: over 2026-10-29 to 2026-11-01, every plugin request from
TRMNL (user agent `Ruby`) carried a numeric `vat` (0 or 0.21), never a blank one. Better Stack keeps 3 days, and
installs that didn't poll in that time aren't covered. Rollout step 3 checks this on live installs before blank gains
any meaning. New installs leave it blank and get `vat=auto`.

### Select values

The same logs show most installs sending `/api/nl/...?interval=60m`, with one configuration still sending `NL` and
`60M`. TRMNL stores a plain option in lower case (`NL` becomes `nl`) and a labelled option exactly as written. So stored
values can be either case. The API accepts both, and any comparison in Liquid or JS must be case-insensitive.

Country options are therefore labelled with lower-case values, which supersedes keeping `NL` and `DE` as they were. A
labelled `NL` wouldn't match the `nl` most installs hold, and the settings form could then pre-select another country,
so a user saving a markup change would silently switch countries. NL is listed first so any value that still doesn't
match falls back to NL. Rollout checks this, since TRMNL's matching isn't documented.

Every select value is quoted. TRMNL's Ruby YAML reads an unquoted `NO` or `no` as boolean `false`, so Norway would
request `/api/false/...`.

### Timeframe: why "All published prices"

`/next/48` returns only what is published (27 of 48 hours when tested at 21:15), and prices run at most to the end
of tomorrow, about 33 hours. A "48 hours" option would never be accurate, so the option is named for what it shows.
Option values contain no slash because TRMNL may rewrite select values, and the URL maps them to paths.

### Polling URL

```liquid
https://dap.xadi.eu/api/{{ country }}/{% if timeframe == 'next12' %}next/12{% elsif timeframe == 'nextall' %}next/48{% else %}{{ timeframe }}{% endif %}?interval={{ resolution }}&markup={{ markup }}&variableMarkup={{ variable_markup }}&roundTo={{ round_to }}&bestPeriodHours={{ best_period_hours | default: 4 }}&vat={% if vat == nil or vat == '' %}auto{% else %}{{ vat }}{% endif %}
```

The timeframe comparison is case-insensitive in the final version; the plan has the exact line.

The API accepts empty `markup`, `variableMarkup`, `roundTo` and `interval` (tested in production). TRMNL documents
the full Liquid library in polling URLs but shows no `{% if %}` example, so rollout step 1 checks it.

## API: `bestPeriodHours`

Add an optional query parameter to `/api/:country/today`, `/next24h` and `/next/:hours`. It is additive: without it,
responses are unchanged. These are design calls, apart from the parameter existing at all.

- **Input:** a whole number from 1 to 24. Empty means not requested, like the other parameters. Anything else, or a
  repeated value, returns 400.
- **Search range:** the prices this response returns, so the result always lies inside `data`.
- **Output:** a top-level `bestPeriod` object:

```json
"bestPeriod": {
  "hours": 4,
  "startTime": "2026-11-02T01:00:00.000Z",
  "endTime": "2026-11-02T05:00:00.000Z",
  "averagePrice": 0.18234,
  "intervals": 4
}
```

- **Length in slots:** `hours * 60 / resolutionMinutes`, using the response's actual resolution, so CH works at `15M`.
- **End time:** exclusive, so the end of the last slot.
- **Price:** the average of the returned `price` values, so it includes markup and VAT, rounded to `roundTo`.
- **Ties:** the earliest period wins.
- **Gaps:** only periods whose slots are consecutive in time count. Compare UTC times, which also makes DST days correct.
- **Too little data:** `bestPeriod` is `null` when it was requested and no period fits, so clients can tell this apart
  from not asking.
- **Keep in sync:** `docs/openapi.yaml`, with tests alongside the existing route and validation tests. No change to the
  price cache, since this is calculated per request from data already fetched.

## Language

- Resolve the language in `shared.liquid`: the `language` setting if set and not `device`, otherwise
  `trmnl.user.locale`, otherwise `en`.
- Normalise to the first two letters, lower case. Treat `nb`, `nn` and `no` as Norwegian. Anything unsupported falls
  back to English, including a locale the plugin has no strings for.
- Blank `language` on an existing install means device language. A Dutch speaker with an English TRMNL account will
  see English after the update; Xander chose this.
- Strings to translate: title for today, title for next N hours, y-axis title, best-period line, "no prices"
  message, and the data-warning notes.
- Dates and numbers are formatted with `Intl` using the resolved language.
- Translations for en and nl are checked by Xander. da, de, fr, nb and sv are best effort, not reviewed by a native
  speaker.

## Chart behaviour

- **Best period:** use the API's `bestPeriod` rather than calculating it in the plugin. The line names the actual length
  ("Best 4-hour period: 02:00 - 06:00") and is hidden when `bestPeriod` is `null`. Mark the bars whose `time` falls from
  `startTime` up to, but not including, `endTime`.
- **Times and dates:** derive them from each item's `time` and `info.timezone`. Never parse `localTime` or `hour`,
  which vary by locale (`So., 1. Nov., 21:00`, `sön 1 nov. 21:00`, `00.00` in DK, and time only on `today`).
- **Title:** matches the data shown. "Today" titles use the date. Next-N titles use the hours actually returned,
  because the API returns fewer than requested before tomorrow's prices are published.
- **Animation:** off on both the chart and the series.
- **Y-axis:** remove the fixed 0.02 tick interval and let Highcharts choose, in a way that stays legible at 215px with
  markup and VAT.
- **X-axis:** thin the labels so 15M (up to about 132 points) stays legible in all layouts.
- **Prices shown as text:** respect `round_to`.
- **Negative prices:** remove the `#ff4444` colour, which has no meaning on these screens. Bars below the zero line
  are distinct enough. The best-period pattern must remain visible on negative bars.
- **Warnings:** show a short translated note for each code in the top-level `warnings` array. It is absent when there
  are none. Entries have the form `fallback_source: stekker`; match on the code before the colon. Show unknown codes
  as a generic "data may be incomplete" note.
- **Empty `data`:** show the translated "no prices" message rather than a blank chart.
- **API errors:** if the template receives a response without `data`, show the same "no prices" message, and the API's
  `message` for a 400 if one is present, since that means a setting is wrong (for example `vat` set to 21). TRMNL's docs
  don't say whether it renders on an error, and the logs show no plugin errors in 3 days, so help text is the main
  protection: `vat` must say "0.21, not 21". Design call.
- **Screen size:** size the chart from its container so it fills the slot, with the pixel sizes below as the 800x480
  result. TRMNL's editor previews other devices, so check it there. Xander knows of no X users, so the original device
  is the priority: a flaw on X or a Kindle is worth noting but doesn't block the release unless the chart is unreadable.
  Design call.
- **Reading the data:** `country` and `markup` are both form fields and response keys, and the docs don't say which
  wins. Read `info.timezone` and `info.resolutionMinutes`, and take settings from
  `trmnl.plugin_settings.custom_fields_values`.
- **Remove:** the tooltip (there's no hover on e-ink), Chartkick (unused), unused variables (`rawTimes`, `hour`).
- **Highcharts:** pin the version, using what TRMNL's chart docs load (12.3.0 when checked).
- **Chart ID:** use `append_random` so two instances in a mashup don't collide.

## Structure

- `shared.liquid` holds the scripts, language resolution, strings and one render function, called with the layout's
  sizes.
- The chart and info containers are in `shared.liquid` too. Each layout file holds only a call with its sizes. Keep the current sizes as the starting point:
  full 400px chart with 18px title; half_horizontal and quadrant 215px with 14px title; half_vertical 400px with 16px
  title and 10px axis labels.
- `settings.yml` holds the fields above. Leave `framework_version` and `refresh_interval` unchanged.

## Repo hygiene

- Delete the `*:Zone.Identifier` files and add that pattern to `.gitignore`.
- Add `integrations` to `.dockerignore` so the plugin isn't copied into the API image.
- Correct `CLAUDE.md`: `/next24h` and `/next/:hours` return 503 only when no prices fall in the window, and otherwise
  return what they have (`routes/countries.js:94`).

## Rollout

Xander performs the TRMNL steps; a builder can't log in to Xander's account. Updating the master reaches everyone, so this
happens in two updates. The first is lower risk, not zero risk: it doesn't use any new setting, but if TRMNL were to
drop a stored `vat`, that install would fall to 0% VAT. The logs would show this within one refresh cycle. TRMNL's docs
don't say whether re-importing the old version restores stored values, so a rollback may not repair it. Design call.

Before anything else, merge and deploy the API change, because the plugin depends on it. It is additive, so existing
installs aren't affected, and merging ships it to production. Then export the current master.

1. **On a clone: polling URL and rendering.** Import the full new plugin as a clone. Use Parse and a real fetch to
   confirm that the `{% if %}` logic works and each timeframe reaches the right path. Check all 4 layouts with
   screenshots on the matrix below. If conditionals don't work in polling URLs, stop: `vat=auto` and the timeframe
   mapping both depend on them, and this design needs revisiting.
   Then, if TRMNL allows it, publish the current version as an unlisted copy, install it as a separate instance, apply
   the step 2 change to the copy, and confirm the instance keeps its values. TRMNL's docs don't say whether an unlisted
   recipe pushes updates to its installs. If it can't be tested this way, the logs in step 3 are the first evidence.
2. **First master update: settings only.** Add the new fields (`variable_markup`, `round_to`, `best_period_hours`, `language`) and make `vat`
   optional with no default. Leave the polling URL, the markup and all existing options as they are, so an empty value
   still means 0% VAT and nothing visible changes. Also install test instances beforehand with `vat` at 0, at 0.21, and
   at its untouched default.
3. **Check the logs.** After at least one full refresh cycle, compare TRMNL's requests in Better Stack with the
   baseline in this document. Every install must keep its `vat`, `markup`, `country` and `interval`. Also read the test
   instances' `custom_fields_values`. If any `vat=` is now blank, stop, because the next update would turn those into
   the country rate. Those installs are now on 0%, so restore from the exported master, check whether their values come
   back, and revisit the VAT design.
4. **Second master update: everything else.** Check the logs again afterwards: no new 4xx or 5xx, and every install's
   `vat` the same as before, with no unexpected `vat=auto`.

Baseline of TRMNL requests for the plugin URL, 2026-10-29 to 2026-11-01. A row can be several installs:

| Country | Timeframe | Interval | Markup | VAT |
|---------|-----------|----------|--------|-----|
| nl | today | 60m | 0 | 0.21 |
| nl | today | 15m | 0 | 0 |
| nl | next24h | 15m | 0 | 0 |
| nl | next24h | 15m | 0 | 0.21 |
| nl | next24h | 60m | 0 | 0 |
| nl | next24h | 60m | 0.12 | 0 |
| nl | next24h | 60m | 0.09 | 0.21 |
| NL | next24h | 60M | 0 | 0 |

Re-run this query just before the first master update, since it's only a 3-day sample. No DE install appeared in it.
The other TRMNL requests in the logs (`/api/nl/next/24`, `/api/nl/today`, `/api/nl/next/48`, `/api/de/next/24`) have no
plugin parameters, so they appear to be someone else's plugins or forks. They're unaffected by this work.

## Verification

There's no Jest coverage for Liquid. The builder renders locally with fixture JSON in a browser, or with TRMNL's
local preview tool if it works. Cover:

- All 9 countries, for today, next12, next24h and nextall, at 60M and 15M. Fixtures come from real API responses.
- CH at 15M (hourly data), and a partial next-24h before prices are published.
- A DST day (92 and 100 quarter-hour points), negative prices, empty `data`, and a response with warnings.
- Each language, plus an unknown locale and a blank one.
- All 4 layouts, in 1-bit.
- Each best-period length, including one that doesn't fit the data (`bestPeriod` is `null`).
- In TRMNL's editor preview: the original device first, then TRMNL X and one Kindle.

For the API: tests for valid and invalid `bestPeriodHours`, CH at `15M`, ties, too little data, a gap in the prices, a
DST day, and responses being unchanged without the parameter. Also run `npm test`, `npm run lint` and
`npm run validate-api`.

## Left to the builder

- How to render fixtures locally.
- Exact wording of strings and help text.
- Layout of the warning note and details of axis thinning.
- The Liquid or JS used to embed API data safely.
- Whether to keep `no_screen_padding`, as long as nothing clips.
