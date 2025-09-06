/* global Chart */
(function () {
  const els = {
    country: document.getElementById('country'),
    markupCents: document.getElementById('markupCents'),
    vatPercent: document.getElementById('vatPercent'),
    timeframe: document.getElementById('timeframe'),
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

  function updatePriceStats(labels, series, unit) {
    const priceStatsEl = document.getElementById('priceStats');

    if (!series || series.length === 0) {
      priceStatsEl.classList.add('hidden');
      return;
    }

    // Calculate statistics
    const minPrice = Math.min(...series);
    const maxPrice = Math.max(...series);
    const avgPrice = series.reduce((sum, price) => sum + price, 0) / series.length;

    const minIndex = series.indexOf(minPrice);
    const maxIndex = series.indexOf(maxPrice);

    // Update the cards with 'price at time' format
    const lowestTime = labels[minIndex] || '--';
    const highestTime = labels[maxIndex] || '--';

    document.getElementById('lowestPriceLabel').textContent =
      `Lowest price at ${lowestTime}: ${minPrice.toFixed(5)} ${unit}`;

    document.getElementById('highestPriceLabel').textContent =
      `Highest price at ${highestTime}: ${maxPrice.toFixed(5)} ${unit}`;

    document.getElementById('averagePriceLabel').textContent =
      `Average price: ${avgPrice.toFixed(5)} ${unit}`;

    // Show the stats
    priceStatsEl.classList.remove('hidden');
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
              callback: (_, idx) => labels[idx]
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
    // Default Netherlands and set its VAT
    els.country.value = 'nl';
    updateVatForCountry('nl');
  }

  function updateVatForCountry(countryCode) {
    const country = countriesCache.find(c => c.code.toLowerCase() === countryCode.toLowerCase());
    if (country && country.defaultVat) {
      const vatPercent = Math.round(country.defaultVat * 100);
      els.vatPercent.value = vatPercent.toString();
    }
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

      const labels = (payload?.data || []).map(p => p.hour ?? new Date(p.time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }));
      const series = (payload?.data || []).map(p => Number(p.price));

      updatePriceStats(labels, series, unit);
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
      btnToday.classList.add('bg-black','text-white','hover:bg-gray-800');
      btnToday.classList.remove('text-gray-700','hover:bg-gray-50');
      btnToday.setAttribute('aria-pressed','true');
      btnNext.classList.remove('bg-black','text-white','hover:bg-gray-800');
      btnNext.classList.add('text-gray-700','hover:bg-gray-50');
      btnNext.setAttribute('aria-pressed','false');
    } else {
      btnNext.classList.add('bg-black','text-white','hover:bg-gray-800');
      btnNext.classList.remove('text-gray-700','hover:bg-gray-50');
      btnNext.setAttribute('aria-pressed','true');
      btnToday.classList.remove('bg-black','text-white','hover:bg-gray-800');
      btnToday.classList.add('text-gray-700','hover:bg-gray-50');
      btnToday.setAttribute('aria-pressed','false');
    }
  }

  function bindEvents() {
    // Country and inputs
    els.country.addEventListener('change', () => { 
      updateVatForCountry(els.country.value);
      saveState(); 
      refresh(); 
    });
    els.markupCents.addEventListener('input', () => { saveState(); refresh(); });
    els.vatPercent.addEventListener('input', () => { saveState(); refresh(); });

    // About modal
    const aboutBtn = document.getElementById('aboutBtn');
    const aboutModal = document.getElementById('aboutModal');
    const closeModal = document.getElementById('closeModal');

    aboutBtn?.addEventListener('click', () => {
      aboutModal.classList.remove('hidden');
      document.body.style.overflow = 'hidden';
    });

    closeModal?.addEventListener('click', () => {
      aboutModal.classList.add('hidden');
      document.body.style.overflow = '';
    });

    aboutModal?.addEventListener('click', (e) => {
      if (e.target === aboutModal) {
        aboutModal.classList.add('hidden');
        document.body.style.overflow = '';
      }
    });

    // API modal
    const apiBtn = document.getElementById('apiBtn');
    const apiModal = document.getElementById('apiModal');
    const closeApiModal = document.getElementById('closeApiModal');
    const copyApiUrl = document.getElementById('copyApiUrl');

    apiBtn?.addEventListener('click', () => {
      // Update the current API endpoint display
      const currentEndpoint = document.getElementById('currentApiEndpoint');
      if (currentEndpoint) {
        currentEndpoint.textContent = currentFullUrl || 'No data loaded yet';
      }
      apiModal.classList.remove('hidden');
      document.body.style.overflow = 'hidden';
    });

    closeApiModal?.addEventListener('click', () => {
      apiModal.classList.add('hidden');
      document.body.style.overflow = '';
    });

    apiModal?.addEventListener('click', (e) => {
      if (e.target === apiModal) {
        apiModal.classList.add('hidden');
        document.body.style.overflow = '';
      }
    });

    copyApiUrl?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(currentFullUrl);
        copyApiUrl.textContent = 'Copied!';
        setTimeout(() => {
          copyApiUrl.innerHTML = `
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/>
            </svg>
            Copy URL
          `;
        }, 2000);
      } catch (err) {
        console.error('Failed to copy URL:', err);
      }
    });

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
        copyBtn.textContent = 'Copied!';
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
      if (saved.country) {
        els.country.value = saved.country;
        updateVatForCountry(saved.country);
      }
      if (saved.markupCents) els.markupCents.value = saved.markupCents;
      if (saved.vatPercent) els.vatPercent.value = saved.vatPercent;
      els.timeframe.value = saved.timeframe || 'next24h';
      setSwitchActive(els.timeframe.value);
    } else {
      // Default to next24h and Netherlands VAT
      els.timeframe.value = 'next24h';
      setSwitchActive('next24h');
      updateVatForCountry('nl');
    }
    bindEvents();
    await refresh();
  }

  document.addEventListener('DOMContentLoaded', init);
})();

