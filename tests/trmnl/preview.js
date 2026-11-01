// Writes one HTML page per verification case, for checking the real Highcharts render in a browser.
// Usage: node tests/trmnl/preview.js <outDir>
const fs = require('fs');
const path = require('path');
const { renderHtml } = require('./harness');

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'trmnl');
// Slot sizes inside an 800x480 screen
const LAYOUTS = {
  full: { width: 800, height: 480 },
  half_horizontal: { width: 800, height: 240 },
  half_vertical: { width: 400, height: 480 },
  quadrant: { width: 400, height: 240 }
};

const fixture = name => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));

// A 15-minute next-24h day: 96 points following the shape of the hourly NL fixture
function quarterHourly() {
  const base = fixture('nl-next24h');
  const data = [];
  base.data.forEach((item, index) => {
    for (let quarter = 0; quarter < 4; quarter++) {
      const next = base.data[index + 1] || item;
      const price = Number((item.price + ((next.price - item.price) * quarter) / 4).toFixed(5));
      data.push({ ...item, price, time: new Date(new Date(item.time).getTime() + quarter * 900000).toISOString() });
    }
  });
  return { ...base, data, info: { ...base.info, totalIntervals: 96, resolutionMinutes: 15 } };
}

const CASES = [
  { name: 'nl', response: fixture('nl-next24h'), language: 'nl' },
  { name: 'nl-today', response: fixture('nl-today'), language: 'nl' },
  { name: 'de', response: fixture('de-next24h'), language: 'de' },
  { name: 'ch-15m', response: fixture('ch-next24h-15m'), language: 'de' },
  { name: 'negative', response: fixture('nl-next24h-negative'), language: 'en' },
  { name: 'q15-96', response: quarterHourly(), language: 'nl' },
  { name: 'q15-dst100', response: fixture('nl-today-dst-100'), language: 'nl' },
  { name: 'warnings', response: fixture('nl-next24h-warnings'), language: 'en' },
  { name: 'warnings-fr', response: fixture('nl-next24h-warnings'), language: 'fr' },
  { name: 'partial', response: fixture('nl-next24h-partial'), language: 'en' },
  { name: 'long-fr', response: fixture('nl-next24h'), language: 'fr' },
  { name: 'long-de', response: fixture('de-next24h'), language: 'de' },
  {
    name: 'empty',
    response: { status: 'error', data: [], message: 'No prices available for this period' },
    language: 'en'
  }
];

async function main() {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error('Usage: node tests/trmnl/preview.js <outDir>');
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const files = [];
  for (const testCase of CASES) {
    for (const [layout, size] of Object.entries(LAYOUTS)) {
      const body = await renderHtml(layout, {
        response: testCase.response,
        fieldValues: { language: testCase.language, round_to: '3' },
        user: { locale: testCase.language }
      });
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#fff;font-family:sans-serif}
.screen{width:800px;height:480px;position:relative;overflow:hidden}
.view{width:${size.width}px;height:${size.height}px;overflow:hidden;position:absolute;left:0;top:0}
</style></head><body><div class="screen"><div class="view view--${layout}">${body}</div></div></body></html>`;
      const file = `${testCase.name}__${layout}.html`;
      fs.writeFileSync(path.join(outDir, file), html);
      files.push(file);
    }
  }
  console.log(`Wrote ${files.length} pages to ${outDir}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
