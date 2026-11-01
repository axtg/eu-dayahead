const fs = require('fs');
const path = require('path');
const vm = require('vm');
const yaml = require('js-yaml');
const { Liquid } = require('liquidjs');

const PLUGIN_DIR = path.join(__dirname, '..', '..', 'integrations', 'trmnl-70055-energy_day_ahead_prices');
const RANDOM_SUFFIX = '-test';

function loadSettings() {
  return yaml.load(fs.readFileSync(path.join(PLUGIN_DIR, 'settings.yml'), 'utf8'));
}

function createEngine() {
  const engine = new Liquid();
  // TRMNL's append_random adds a random suffix; a fixed one keeps the output stable
  engine.registerFilter('append_random', value => `${value}${RANDOM_SUFFIX}`);
  // TRMNL uses JSON.generate, which renders nil as null where liquidjs would give an empty string
  engine.registerFilter('json', value => JSON.stringify(value ?? null));
  return engine;
}

function renderPollingUrl(fieldValues) {
  return createEngine().parseAndRender(loadSettings().polling_url, fieldValues);
}

function buildVariables({ response, fieldValues, user, mergeOrder }) {
  const fields = fieldValues || {};
  const data = response || {};
  const merged = mergeOrder === 'fields-win' ? { ...data, ...fields } : { ...fields, ...data };
  return {
    ...merged,
    trmnl: {
      plugin_settings: { custom_fields_values: fields },
      user: user || {}
    }
  };
}

function createElement(id, slotHeight) {
  const slot = slotHeight ? { clientHeight: slotHeight, offsetHeight: slotHeight } : null;
  return {
    id,
    innerHTML: '',
    style: {},
    clientHeight: slotHeight || 0,
    offsetHeight: slotHeight || 0,
    closest: () => slot
  };
}

function extractInlineScripts(html) {
  const scripts = [];
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    if (!/\bsrc\s*=/.test(match[1])) {
      scripts.push(match[2]);
    }
  }
  return scripts;
}

async function renderLayout(layoutName, { response, fieldValues, user, mergeOrder, slotHeight } = {}) {
  const engine = createEngine();
  const variables = buildVariables({ response, fieldValues, user, mergeOrder });
  const read = name => fs.readFileSync(path.join(PLUGIN_DIR, `${name}.liquid`), 'utf8');
  const html = await engine.parseAndRender(
    `${read('shared')}\n${read(layoutName)}\n<!--chart_id:{{ chart_id }}-->`,
    variables
  );
  // A layout that assigns chart_id names its chart and info elements after it; the current layouts don't
  const chartId = (html.match(/<!--chart_id:(.*?)-->/) || [])[1] || null;

  const ids = new Set([...html.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)].map(m => m[1]));
  const elements = {};
  for (const id of ids) {
    elements[id] = createElement(id, slotHeight);
  }

  let chart = null;
  const errors = [];
  const listeners = {};
  const window = {
    addEventListener: (type, fn) => {
      (listeners[type] = listeners[type] || []).push(fn);
    }
  };
  const context = vm.createContext({
    window,
    document: { getElementById: id => elements[id] || null },
    Highcharts: {
      chart: (container, config) => {
        chart = config;
        return { container, config };
      }
    },
    console
  });

  for (const script of extractInlineScripts(html)) {
    try {
      vm.runInContext(script, context);
    } catch (error) {
      errors.push(error);
    }
  }

  const found = id => (id && elements[id]) || null;
  return {
    chart,
    elements: { chart: found(chartId), info: found(chartId && `${chartId}-info`) },
    errors
  };
}

module.exports = { loadSettings, renderPollingUrl, renderLayout };
