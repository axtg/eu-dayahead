/* global Chart */
(function () {
  const els = {
    country: document.getElementById('country'),
    markupCents: document.getElementById('markupCents'),
    vatPercent: document.getElementById('vatPercent'),
    timeframe: document.getElementById('timeframe'),
    unitLabel: document.getElementById('unitLabel'),
    status: document.getElementById('statusMessage')
  };

  let chart;
  let countriesCache = [];

  function centsToEuros(cents) {
    const n = Number(cents);
    return isFinite(n) ? n / 100 : 0;
  }

  function percentToDecimal(pct) {
    const n = Number(pct);
    return isFinite(n) ? n / 100 : 0;
  }

  function buildEndpoint({ country, timeframe, markupCents, vatPercent }) {
    const tfPath = timeframe === 'next24h' ? 'next24h' : 'today';
    const base = `/api/${country}/${tfPath}`;

    const params = new URLSearchParams();
    const markup = centsToEuros(markupCents);
    const vat = percentToDecimal(vatPercent);
    if (markup > 0) params.set('markup', markup.toString());
    if (vat > 0) params.set('vat', vat.toString());

    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  }

  let currentFullUrl = '';
  function setApiUrlDisplay(endpoint) {
    currentFullUrl = `${window.location.origin}${endpoint}`;
    const apiEl = document.getElementById('apiUrl');
    if (apiEl) apiEl.textContent = currentFullUrl;
  }


  function highlightExtremes(data) {
    if (!Array.isArray(data) || data.length === 0) return { min1: -1, min2: -1, max1: -1, max2: -1 };
    const withIdx = data.map((v, i) => ({ v, i }));
    const sorted = [...withIdx].sort((a, b) => a.v - b.v);
    const min1 = sorted[0]?.i ?? -1;
    const min2 = sorted[1]?.i ?? -1;
    const max1 = sorted[sorted.length - 1]?.i ?? -1;
    const max2 = sorted[sorted.length - 2]?.i ?? -1;
    return { min1, min2, max1, max2 };
  }

  function renderChart(labels, series, unit) {
    const ctx = document.getElementById('priceChart');

    if (chart) {
      chart.destroy();
    }

    const { min1, min2, max1, max2 } = highlightExtremes(series);

    // Colors
    const COLOR_CHEAPEST = '#065f46'; // dark green
    const COLOR_SECOND_CHEAPEST = '#10b981'; // light green (emerald)
    const COLOR_MID = '#eab308'; // yellow
    const COLOR_SECOND_EXPENSIVE = '#f59e0b'; // orange
    const COLOR_MOST_EXPENSIVE = '#7f1d1d'; // dark red

    const pointBackground = series.map((_, i) => {
      if (i === min1) return COLOR_CHEAPEST;
      if (i === min2) return COLOR_SECOND_CHEAPEST;
      if (i === max2) return COLOR_SECOND_EXPENSIVE;
      if (i === max1) return COLOR_MOST_EXPENSIVE;
      return COLOR_MID;
    });

    const pointRadius = series.map((_, i) => (i === min1 || i === max1 ? 5 : i === min2 || i === max2 ? 4 : 3));

    chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: `Price (${unit})`,
            data: series,
            borderColor: 'rgb(17, 24, 39)',
            backgroundColor: 'rgba(17, 24, 39, 0.08)',
            fill: true,
            tension: 0.35,
            pointBackgroundColor: pointBackground,
            pointRadius,
            borderWidth: 2
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const v = ctx.parsed.y;
                return ` ${v.toFixed(5)} ${unit}`;
              }
            }
          }
        },
        scales: {
          x: {
            ticks: {
              maxRotation: 0,
              callback: (val, idx) => labels[idx]
            }
          },
          y: {
            title: { display: true, text: unit },
            ticks: { precision: 5 }
          }
        }
      }
    });
  }

  async function fetchJSON(url) {
    const res = await fetch(url, { headers: { 'accept': 'application/json' } });
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    return res.json();
  }

  async function loadCountries() {
    const data = await fetchJSON('/api/countries');
    countriesCache = data.data || [];
    els.country.innerHTML = countriesCache
      .map(c => `<option value="${c.code.toLowerCase()}">${c.name}</option>`)
      .join('');
    // Default Netherlands
    els.country.value = 'nl';
  }

  function debounce(fn, delay = 250) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), delay);
    };
  }

  async function refresh() {
    try {
      els.status.textContent = '';
      const country = els.country.value || 'nl';
      const timeframe = els.timeframe.value || 'next24h';
      const markupCents = els.markupCents.value || '0';
      const vatPercent = els.vatPercent.value || '0';

      const endpoint = buildEndpoint({ country, timeframe, markupCents, vatPercent });
      setApiUrlDisplay(endpoint);

      const payload = await fetchJSON(endpoint);
      const unit = payload?.info?.priceUnit || 'EUR/kWh';
      els.unitLabel.textContent = unit;

      const labels = (payload?.data || []).map(p => p.hour ?? new Date(p.time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }));
      const series = (payload?.data || []).map(p => Number(p.price));

      renderChart(labels, series, unit);
    } catch (err) {
      console.error(err);
      els.status.textContent = 'Failed to load data';
    }
  }

  function setSwitchActive(which) {
    const btnToday = document.getElementById('tfToday');
    const btnNext = document.getElementById('tfNext24h');
    if (!btnToday || !btnNext) return;
    if (which === 'today') {
      btnToday.classList.add('bg-black','text-white');
      btnToday.setAttribute('aria-pressed','true');
      btnNext.classList.remove('bg-black','text-white');
      btnNext.setAttribute('aria-pressed','false');
    } else {
      btnNext.classList.add('bg-black','text-white');
      btnNext.setAttribute('aria-pressed','true');
      btnToday.classList.remove('bg-black','text-white');
      btnToday.setAttribute('aria-pressed','false');
    }
  }

  function bindEvents() {
    // Country and inputs
    els.country.addEventListener('change', () => { saveState(); refresh(); });
    els.markupCents.addEventListener('input', () => { saveState(); refresh(); });
    els.vatPercent.addEventListener('input', () => { saveState(); refresh(); });


    // Timeframe switch
    const btnToday = document.getElementById('tfToday');
    const btnNext = document.getElementById('tfNext24h');
    btnToday?.addEventListener('click', () => {
      els.timeframe.value = 'today';
      setSwitchActive('today');
      saveState();
      refresh();
    });
    btnNext?.addEventListener('click', () => {
      els.timeframe.value = 'next24h';
      setSwitchActive('next24h');
      saveState();
      refresh();
    });

    // Copy button
    const copyBtn = document.getElementById('copyBtn');
    copyBtn?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(currentFullUrl || '');
        const original = copyBtn.textContent;
        copyBtn.textContent = 'Copied';
        setTimeout(() => (copyBtn.textContent = original), 1000);
      } catch (e) {
        console.error('Copy failed', e);
      }
    });
  }

  // Local storage
  const LS_KEY = 'dap_ui_state_v1';
  function saveState() {
    try {
      const state = {
        country: els.country.value,
        timeframe: els.timeframe.value,
        markupCents: els.markupCents.value,
        vatPercent: els.vatPercent.value
      };
      localStorage.setItem(LS_KEY, JSON.stringify(state));
    } catch {}
  }
  function loadState() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async function init() {
    await loadCountries();
    const saved = loadState();
    if (saved) {
      if (saved.country) els.country.value = saved.country;
      if (saved.markupCents) els.markupCents.value = saved.markupCents;
      if (saved.vatPercent) els.vatPercent.value = saved.vatPercent;
      els.timeframe.value = saved.timeframe || 'next24h';
      setSwitchActive(els.timeframe.value);
    } else {
      // Default to next24h
      els.timeframe.value = 'next24h';
      setSwitchActive('next24h');
    }
    bindEvents();
    await refresh();
  }

  document.addEventListener('DOMContentLoaded', init);
})();

