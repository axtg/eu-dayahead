[![CI/CD Pipeline](https://github.com/axtg/eu-dayahead/actions/workflows/ci.yml/badge.svg?branch=main&event=push)](https://github.com/axtg/eu-dayahead/actions/workflows/ci.yml)

[!["Buy me a coffee"](https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png)](https://www.buymeacoffee.com/xander.groesbeek)

# 🌍 European energy prices API

A comprehensive REST API for fetching real-time electricity prices across 9 EU countries, with support for energy provider markups, VAT calculations, and flexible time periods.

## 🚀 Features

- **9 European countries** - Netherlands, Germany, Belgium, France, Austria, Switzerland, Denmark, Norway, Sweden
- **Multiple time periods** - Today, tomorrow, next 24 hours, custom date ranges
- **Provider markups** - Built-in support for energy provider pricing (Next Energy, Vattenfall, Eneco)
- **Flexible VAT** - Country-specific VAT rates or custom percentages
- **Multi-currency** - EUR, CHF, DKK, NOK, SEK support
- **Timezone aware** - Proper timezone handling for each country
- **Clean REST API** - Intuitive `/api/{country}/{timeframe}` structure

## 📦 Installation

```bash
# Clone the repository
git clone https://github.com/axtg/eu-dayahead.git
cd eu-dayahead

# Install dependencies
npm install

# Copy environment variables
cp .env.example .env

# Edit environment variables (optional)
nano .env

# Start the server
npm start

# For development (auto-restart)
npm run dev
```

### 🔑 Environment variables

Create a `.env` file based on `.env.example`:

```bash
# Required
PORT=3000
NODE_ENV=development

# Optional: ENTSOE API Key for more reliable data
ENTSOE_API_KEY=your-api-key-from-entsoe

# Optional: Customize cache and rate limiting
CACHE_TIMEOUT_MS=3600000
RATE_LIMIT_MAX_REQUESTS=100
```

**Getting an ENTSOE API Key (recommended):**

1. Register at [ENTSOE Transparency Platform](https://transparency.entsoe.eu/)
2. Request API access (free, takes 1-3 business days)
3. Add your API key to `.env`
4. Restart the server - it will automatically use ENTSOE as primary data source

### 🐳 Docker setup

```bash
# Build and run with Docker
docker build -t eu-energy-api .
docker run -p 3000:3000 eu-energy-api

# Or use Docker compose
docker compose up -d
```

## 🌍 Supported countries

| Code | Country     | Currency | Default VAT | Timezone          |
| ---- | ----------- | -------- | ----------- | ----------------- |
| `nl` | Netherlands | EUR      | 21%         | Europe/Amsterdam  |
| `de` | Germany     | EUR      | 19%         | Europe/Berlin     |
| `be` | Belgium     | EUR      | 21%         | Europe/Brussels   |
| `fr` | France      | EUR      | 20%         | Europe/Paris      |
| `at` | Austria     | EUR      | 20%         | Europe/Vienna     |
| `ch` | Switzerland | CHF      | 7.7%        | Europe/Zurich     |
| `dk` | Denmark     | DKK      | 25%         | Europe/Copenhagen |
| `no` | Norway      | NOK      | 25%         | Europe/Oslo       |
| `se` | Sweden      | SEK      | 25%         | Europe/Stockholm  |

## 🎯 Quick start examples

### Get today's prices for Netherlands

```bash
curl http://localhost:3000/api/nl/today
```

### Get today's prices with Next Energy markup

```bash
curl "http://localhost:3000/api/nl/today?markup=0.024&vat=0.21"
```

### Get German prices with 'auto VAT'

```bash
curl "http://localhost:3000/api/de/today?autoVat=true"
```

### List all supported countries

```bash
curl http://localhost:3000/api/countries
```

## 📋 API endpoints

### 🎯 Country-specific endpoints (recommended)

| Endpoint                      | Description                     | Example            |
| ----------------------------- | ------------------------------- | ------------------ |
| `GET /api/countries`          | List all supported countries    |                    |
| `GET /api/{country}/today`    | Today's prices (00:00-23:59)    | `/api/nl/today`    |
| `GET /api/{country}/next24h`  | Next 24 hours from now          | `/api/fr/next/24`  |

### 🇳🇱 Netherlands shortcuts 

| Endpoint            | Description          | Equivalent To      |
| ------------------- | -------------------- | ------------------ |
| `GET /api/today`    | Netherlands today    | `/api/nl/today`    |
| `GET /api/next/24`  | Netherlands next 24h |                    |

### 🏢 Energy provider presets

| Endpoint                                  | Description               |
| ----------------------------------------- | ------------------------- |
| `GET /api/providers`                      | List all providers        |
| `GET /api/providers/next-energy`          | Next Energy preset (NL)   |
| `GET /api/providers/{provider}/{country}` | Generic provider endpoint |

## 📊 Query parameters

| Parameter                 | Type    | Description                | Example          |
| ------------------------- | ------- | -------------------------- | ---------------- |
| `markup` or `fixedMarkup` | Number  | Fixed markup per kWh       | `0.024`          |
| `vat`                     | Number  | VAT as decimal             | `0.21` (for 21%) |
| `autoVat`                 | Boolean | Use country's default VAT  | `true`           |
| `roundTo`                 | Integer | Decimal places to round to | `5` (default)    |

## 💡 Usage examples

### Basic usage

```javascript
// Get today's raw prices for Netherlands
fetch('http://localhost:3000/api/nl/today')
  .then(response => response.json())
  .then(data => console.log(data));
```

### With Next Energy markup

```javascript
// Next Energy pricing with VAT
fetch('http://localhost:3000/api/nl/today?markup=0.024&vat=0.21')
  .then(response => response.json())
  .then(data => {
    data.data.forEach(price => {
      console.log(`${price.hour}: €${price.price.toFixed(5)}/kWh`);
    });
  });
```

### Multi-country comparison

```javascript
const countries = ['nl', 'de', 'fr', 'be'];
const promises = countries.map(country =>
  fetch(`http://localhost:3000/api/${country}/today?autoVat=true`).then(r => r.json())
);

Promise.all(promises).then(results => {
  results.forEach(result => {
    console.log(`${result.country.name}: Average price today`);
  });
});
```

## 🏗️ Project structure

```
├── index.js              # Main server file
├── package.json          # Dependencies & scripts
├── stekker.js           # Stekker.app API integration
├── entsoe.js            # ENTSOE API integration
├── config/
│   └── countries.js     # Country configurations
├── utils/
│   └── helpers.js       # Helper functions
└── routes/
    ├── countries.js     # Country-specific endpoints
    ├── legacy.js        # Backward compatibility
    └── providers.js     # Energy provider presets
```

## 🔧 Configuration

### Adding new countries

Edit `config/countries.js`:

```javascript
const COUNTRIES = {
  // ... existing countries
  gb: {
    name: 'United Kingdom',
    biddingZone: '10YGB----------A',
    stekkerRegion: 'GB',
    currency: 'GBP',
    timezone: 'Europe/London',
    defaultVat: 0.2,
    locale: 'en-GB'
  }
};
```

### Adding new energy providers

Edit `routes/providers.js`:

```javascript
const PROVIDER_PRESETS = {
  // ... existing providers
  'your-provider': {
    name: 'Your Provider',
    countries: ['nl', 'de'],
    markup: { fixedMarkup: 0.025, vat: 'auto' }
  }
};
```

## 📈 Response format

```json
{
  "status": "success",
  "country": {
    "code": "NL",
    "name": "Netherlands",
    "currency": "EUR",
    "timezone": "Europe/Amsterdam"
  },
  "data": [
    {
      "time": "2025-05-23T00:00:00.000Z",
      "priceRaw": 87.12,
      "price": 0.13442,
      "hour": "02:00",
      "localTime": "02:00",
      "markup": {
        "fixed": 0.024,
        "variable": 0,
        "vat": 0.21,
        "vatPercent": "21%",
        "originalPrice": 0.08712
      }
    }
  ],
  "markup": {
    "fixedMarkup": 0.024,
    "variableMarkup": 0,
    "vat": 0.21,
    "includeVat": true,
    "roundTo": 5
  },
  "fetchedAt": "2025-05-22T13:08:42.000Z",
  "info": {
    "type": "today",
    "date": "22-5-2025",
    "totalHours": 24,
    "priceUnit": "EUR/kWh",
    "timezone": "Europe/Amsterdam"
  }
}
```

## 🔗 Data sources

- **Primary**: [ENTSOE Transparency Platform](https://transparency.entsoe.eu) - Official EU energy data (requires API key)
- **Backup**: [Stekker.app](https://stekker.app) - European energy price aggregator

## ⚡ Performance

- **Caching**: 1-hour cache for raw prices to reduce API calls
- **Rate Limiting**: Built-in delays to respect upstream API limits
- **Concurrent Requests**: Supports multiple simultaneous country requests

## 🛠️ Development

```bash
# Install dev dependencies
npm install --save-dev nodemon

# Start with auto-restart
npm run dev

# Add new routes
# Edit files in routes/ directory

# Add new countries
# Edit config/countries.js
```

## 🧪 Testing

```bash
# Run all tests
npm test

# Run tests with coverage
npm run test:coverage

# Run tests in watch mode (development)
npm run test:watch

# Run linting
npm run lint

# Fix linting issues
npm run lint:fix

# Validate API specification
npm run validate-api
```

## 🔄 CI/CD

The project includes a complete GitHub Actions workflow:

- **Automated Testing** - Runs on Node.js 16, 18, and 20
- **Code Quality** - ESLint, security audits, and coverage reports
- **API Validation** - Validates OpenAPI specification
- **Docker Build** - Builds and pushes Docker images
- **Deployment** - Staging and production deployment workflows

### GitHub secrets required:

```bash
ENTSOE_API_KEY=your-entsoe-api-key
```

### Common issues

**Port already in use:**

```bash
# Kill process on port 3000
pkill -f "node.*3000"
# Or change port in index.js
```

**Country not supported:**

```bash
curl http://localhost:3000/api/countries
# Check supported country codes
```

**No price data:**

- Check if it's a weekend (some markets have limited data)
- Verify the date range is not too far in the future
- Check if the upstream data source is available

### Error Responses

```json
{
  "status": "error",
  "message": "Unsupported country: xx. Use /api/countries to see supported countries."
}
```

## 📄 License

MIT License - feel free to use this project for personal or commercial purposes.

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📞 Support

- Create an issue for bugs or feature requests
- Check existing issues before creating new ones
- Provide clear reproduction steps for bugs

## 🎉 Acknowledgments

- [Stekker.app](https://stekker.app) for providing accessible energy price data
- [ENTSOE](https://transparency.entsoe.eu) for official European energy transparency
- The European energy market for making this data publicly available
