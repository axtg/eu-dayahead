# 🌍 European Energy Prices API

A comprehensive REST API for fetching real-time electricity prices across 9 European countries, with support for energy provider markups, VAT calculations, and flexible time periods.

## 🚀 Features

- **9 European Countries** - Netherlands, Germany, Belgium, France, Austria, Switzerland, Denmark, Norway, Sweden
- **Multiple Time Periods** - Today, tomorrow, next 24 hours, custom date ranges
- **Provider Markups** - Built-in support for energy provider pricing (Next Energy, Vattenfall, Eneco)
- **Flexible VAT** - Country-specific VAT rates or custom percentages
- **Multi-Currency** - EUR, CHF, DKK, NOK, SEK support
- **Timezone Aware** - Proper timezone handling for each country
- **Clean REST API** - Intuitive `/api/{country}/{timeframe}` structure

## 📦 Installation

```bash
# Clone the repository
git clone <your-repo-url>
cd european-energy-prices-api

# Install dependencies
npm install

# Start the server
npm start

# For development (auto-restart)
npm run dev
```

## 🌍 Supported Countries

| Code | Country | Currency | Default VAT | Timezone |
|------|---------|----------|-------------|----------|
| `nl` | Netherlands | EUR | 21% | Europe/Amsterdam |
| `de` | Germany | EUR | 19% | Europe/Berlin |
| `be` | Belgium | EUR | 21% | Europe/Brussels |
| `fr` | France | EUR | 20% | Europe/Paris |
| `at` | Austria | EUR | 20% | Europe/Vienna |
| `ch` | Switzerland | CHF | 7.7% | Europe/Zurich |
| `dk` | Denmark | DKK | 25% | Europe/Copenhagen |
| `no` | Norway | NOK | 25% | Europe/Oslo |
| `se` | Sweden | SEK | 25% | Europe/Stockholm |

## 🎯 Quick Start Examples

### Get Today's Prices for Netherlands
```bash
curl http://localhost:3000/api/nl/today
```

### Get Tomorrow's Prices with Next Energy Markup
```bash
curl "http://localhost:3000/api/nl/tomorrow?markup=0.024&vat=0.21"
```

### Get German Prices with Auto VAT
```bash
curl "http://localhost:3000/api/de/today?autoVat=true"
```

### List All Supported Countries
```bash
curl http://localhost:3000/api/countries
```

## 📋 API Endpoints

### 🎯 Country-Specific Endpoints

| Endpoint | Description | Example |
|----------|-------------|---------|
| `GET /api/countries` | List all supported countries | |
| `GET /api/{country}/today` | Today's prices (00:00-23:59) | `/api/nl/today` |
| `GET /api/{country}/tomorrow` | Tomorrow's prices (00:00-23:59) | `/api/de/tomorrow` |
| `GET /api/{country}/next24h` | Next 24 hours from now | `/api/fr/next24h` |

### 🏢 Energy Provider Presets

| Endpoint | Description |
|----------|-------------|
| `GET /api/providers` | List all providers |
| `GET /api/providers/next-energy` | Next Energy preset (NL) |
| `GET /api/providers/{provider}/{country}` | Generic provider endpoint |

## 📊 Query Parameters

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `markup` or `fixedMarkup` | Number | Fixed markup per kWh | `0.024` |
| `variableMarkup` | Number | Variable markup percentage | `5` (for 5%) |
| `vat` | Number | VAT as decimal | `0.21` (for 21%) |
| `autoVat` | Boolean | Use country's default VAT | `true` |
| `roundTo` | Integer | Decimal places to round to | `5` (default) |

## 💡 Usage Examples

### Basic Usage
```javascript
// Get today's raw prices for Netherlands
fetch('http://localhost:3000/api/nl/today')
  .then(response => response.json())
  .then(data => console.log(data));
```

### With Next Energy Markup
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

### Multi-Country Comparison
```javascript
const countries = ['nl', 'de', 'fr', 'be'];
const promises = countries.map(country => 
  fetch(`http://localhost:3000/api/${country}/today?autoVat=true`)
    .then(r => r.json())
);

Promise.all(promises).then(results => {
  results.forEach(result => {
    console.log(`${result.country.name}: Average price today`);
  });
});
```

## 🏗️ Project Structure

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

### Adding New Countries

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
    defaultVat: 0.20,
    locale: 'en-GB'
  }
};
```

### Adding New Energy Providers

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

## 📈 Response Format

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

## 🔗 Data Sources

- **Primary**: [Stekker.app](https://stekker.app) - European energy price aggregator
- **Backup**: [ENTSOE Transparency Platform](https://transparency.entsoe.eu) - Official EU energy data (requires API key)

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

## 🐛 Troubleshooting

### Common Issues

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