# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev              # Start with nodemon (auto-restart)
npm start                # Start server (node index.js)
npm test                 # Run Jest test suite
npm test -- tests/api.test.js               # Run a single test file
npm test -- -t "GET /api/nl/today"          # Run tests matching a name pattern
npm run test:coverage    # Jest with coverage report
npm run lint             # ESLint check
npm run lint:fix         # ESLint auto-fix
npm run format           # Prettier write
npm run validate-api     # Validate docs/openapi.yaml via swagger-parser
npm run docker:build     # docker build -f docker/Dockerfile -t eu-energy-api .
```

Server defaults to `PORT=3000`. Copy `.env.example` to `.env` for local config.

## Architecture

Express REST API that aggregates day-ahead electricity prices for 9 European countries, applies markup/VAT/rounding, and serves results plus a static landing page.

### Request flow

1. `index.js` is the entry. It mounts `loggingMiddleware` (Better Stack/Logtail), serves `public/` statically, applies a per-IP in-memory rate limiter to `/api` routes (`RATE_LIMIT_RPS`, default 10/sec, returns `X-RateLimit-*` headers and 429 with `Retry-After`), and exposes `/health`, `/health/cache`, `/openapi.yaml`.
2. `routes/countries.js` handles `/api/countries`, `/api/:country/today`, `/api/:country/next24h`, `/api/:country/next/:hours` (1–48). Timezone-correct day boundaries are computed with `date-fns-tz` (`toZonedTime` → `startOfDay`/`startOfHour` → `fromZonedTime`).
3. `routes/providers.js` handles `/api/providers`, `/api/providers/next-energy`, and the generic `/api/providers/:provider/:country`. Provider markup presets (Next Energy, Vattenfall, Eneco) live inline in this file; `vat: 'auto'` is resolved to the country's `defaultVat`.
4. `utils/helpers.js` is the shared layer: `validateCountry`, `parseMarkupOptions`, `fetchCountryPrices`, `enrichPricesWithCountryInfo`, `buildCountryResponse`. **`fetchCountryPrices(countryCode, markupOptions, { interval }?)` ignores caller-supplied date ranges entirely; it fetches a single canonical window per country (yesterday-start through 3 days out, in country tz) and caches it under `country|YYYY-MM-DD` (today in country tz).** Each entry has a `refreshAfter` that points at today's 14:30 CET (the ENTSOE day-ahead publish boundary) if we're before it, or country-local midnight if we're past it. Net effect: ~1–2 upstream calls per country per day regardless of traffic, and changing markup/VAT never re-hits the upstream. Routes filter the canonical window to their request span.
5. `stekker.js` (`StekkerAPI`) is the legacy upstream client (HTML scrape of `stekker.app/epex-forecast`, parses Plotly JSON, returns hourly EUR/kWh). It's the **fallback** path inside `fetchRawPrices` when `ENTSOE_API_KEY` is missing or ENTSOE returns empty/errors. Stekker has known artifacts (rejects several non-NL bidding zones; HH:00 quarters can carry stale hourly clearing prices) — when used, the response includes a `warnings` array.
6. `entsoe.js` (`EntsoeAPI`) is the **primary** upstream when `ENTSOE_API_KEY` is set. Returns quarter-hour resolution for most zones, hourly for Switzerland. The `interval=60M` default aggregates quarters to hourly means; `interval=15M` passes them through.

### Country & timezone model

- All supported countries are defined in `config/countries.js` with `biddingZone` (ENTSOE), `stekkerRegion`, `currency`, `timezone`, `defaultVat`, `locale`. **To add a country, edit only this file** — routes derive everything from it.
- Routes compute precise UTC bounds by converting target-tz day/hour boundaries via `date-fns-tz`, then filter the canonical window in UTC. This is the established pattern for DST and country-local "today".

### Markup pipeline

Order in `StekkerAPI.applyMarkup`: variable markup (%) → fixed markup (currency/kWh) → VAT multiplier → round to `roundTo` decimals (default 5). `parseMarkupOptions` accepts `markup` or `fixedMarkup` (alias), `variableMarkup`, `vat`, `autoVat=true` (uses country `defaultVat`), `includeVat`, `roundTo`.

### Tests

- Jest with `tests/setup.js`, 30s timeout, supertest against the exported `app` (no listen).
- Coverage scope: `routes/`, `utils/`, `config/`. `tests/api.test.js` hits live endpoints, so it depends on the upstream Stekker API being reachable.

## Conventions

- Single quotes, semicolons, 2-space indent, no trailing commas, max 120 cols (see `.eslintrc.js`).
- `console.log`/`console.error` are allowed (server app); errors are forwarded to Better Stack via `logError`.
- Static frontend lives in `public/` (vanilla JS + Tailwind CDN + Chart.js); the OpenAPI spec at `docs/openapi.yaml` is the contract — keep it in sync when adding/changing endpoints and run `npm run validate-api`.
