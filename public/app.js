/* global Chart, CheapestStart */
(function () {
  const els = {
    country: document.getElementById('country'),
    markupCents: document.getElementById('markupCents'),
    vatPercent: document.getElementById('vatPercent'),
    timeframe: document.getElementById('timeframe'),
    interval: document.getElementById('interval'),
    windSolar: document.getElementById('windSolar'),
    windSolarNote: document.getElementById('windSolarNote'),
    cheapestLength: document.getElementById('cheapestLength'),
    status: document.getElementById('statusMessage')
  };



  let chart;
  let lastChartArgs = null;
  let latestRequestId = 0;
  let countriesCache = [];

  function centsToEuros(cents) {
    const n = Number(cents);
    return isFinite(n) ? n / 100 : 0;
  }

  function percentToDecimal(pct) {
    const n = Number(pct);
    return isFinite(n) ? n / 100 : 0;
  }

  function buildEndpoint({ country, timeframe, markupCents, vatPercent, interval, includeWindSolar }) {
    const base = `/api/${country}/${timeframe}`;

    const params = new URLSearchParams();
    const markup = centsToEuros(markupCents);
    const vat = percentToDecimal(vatPercent);
    if (markup > 0) params.set('markup', markup.toString());
    if (vat > 0) params.set('vat', vat.toString());
    if (interval && interval !== '60M') params.set('interval', interval);
    if (includeWindSolar) params.set('includeWindSolar', 'true');

    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  }

  // Integrations: the calendar card builds a feed URL from the page's settings.
  const CALENDAR_DEFAULTS = { hours: 4, from: 7, to: 22 };
  const pad = hour => `${String(hour).padStart(2, '0')}:00`;

  function fillOptions(select, values, label, selected) {
    select.replaceChildren(
      ...values.map(value => {
        const option = new Option(label(value), value);
        option.selected = value === selected;
        return option;
      })
    );
  }

  function buildCalendarPath({ country, markupCents, vatPercent, hours, from, to }) {
    const params = new URLSearchParams({ hours });
    if (from > 0) params.set('from', from);
    if (to < 24) params.set('to', to);
    const markup = centsToEuros(markupCents);
    const vat = percentToDecimal(vatPercent);
    if (markup > 0) params.set('markup', markup.toString());
    if (vat > 0) params.set('vat', vat.toString());
    return `/api/${country}/calendar.ics?${params}`;
  }

  function calendarSettingsText() {
    const countryName = els.country.selectedOptions[0]?.textContent.trim() || '';
    const vat = Number(els.vatPercent.value) || 0;
    const markup = Number(els.markupCents.value) || 0;
    const prices = `${vat > 0 ? `${vat}% VAT` : 'no VAT'}, ${markup > 0 ? `${markup} ct markup` : 'no markup'}`;
    return `From this page's settings: ${countryName}, ${prices}.`;
  }

  function setupCalendarCard() {
    const hoursEl = document.getElementById('calendarHours');
    const fromEl = document.getElementById('calendarFrom');
    const toEl = document.getElementById('calendarTo');
    const subscribe = document.getElementById('calendarSubscribe');
    const copy = document.getElementById('calendarCopy');
    const settings = document.getElementById('calendarSettings');
    const range = (start, end) => Array.from({ length: end - start + 1 }, (_, i) => start + i);

    fillOptions(hoursEl, range(1, 24), value => `${value} ${value === 1 ? 'hour' : 'hours'}`, CALENDAR_DEFAULTS.hours);
    fillOptions(fromEl, range(0, 23), pad, CALENDAR_DEFAULTS.from);
    fillOptions(toEl, range(1, 24), pad, CALENDAR_DEFAULTS.to);

    let feedUrl = '';
    function update() {
      const hours = Number(hoursEl.value);
      const from = Number(fromEl.value);
      const to = Number(toEl.value);
      const fits = to - from >= hours;
      const path = buildCalendarPath({
        country: els.country.value,
        markupCents: els.markupCents.value,
        vatPercent: els.vatPercent.value,
        hours,
        from,
        to
      });
      feedUrl = fits ? `${window.location.origin}${path}` : '';
      subscribe.href = fits ? feedUrl.replace(/^https?:/, 'webcal:') : '#';
      subscribe.classList.toggle('hidden', !fits);
      copy.classList.toggle('hidden', !fits);
      settings.textContent = fits
        ? calendarSettingsText()
        : `A ${hours}-hour window doesn't fit between ${pad(from)} and ${pad(to)}.`;
    }

    [hoursEl, fromEl, toEl].forEach(el => el.addEventListener('change', update));
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(feedUrl);
        copy.textContent = 'Copied!';
        setTimeout(() => (copy.textContent = 'Copy link'), 1000);
      } catch (e) {
        console.error('Copy failed', e);
      }
    });
    return update;
  }

  function setupMcpCard() {
    const copy = document.getElementById('mcpCopy');
    const url = `${window.location.origin}/mcp`;
    document.getElementById('mcpUrl').textContent = url;
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(url);
        copy.textContent = 'Copied!';
        setTimeout(() => (copy.textContent = 'Copy link'), 1000);
      } catch (e) {
        console.error('Copy failed', e);
      }
    });
  }

  let openIntegrationsFromHash = () => {};

  function setupIntegrationsModal() {
    const modal = document.getElementById('integrationsModal');
    const updateCalendarCard = setupCalendarCard();
    setupMcpCard();

    function open() {
      document.getElementById('aboutModal').classList.add('hidden');
      updateCalendarCard();
      modal.classList.remove('hidden');
      document.body.style.overflow = 'hidden';
    }
    function close() {
      modal.classList.add('hidden');
      document.body.style.overflow = '';
      if (window.location.hash === '#integrations') history.replaceState(null, '', window.location.pathname);
    }

    document.getElementById('integrationsBtn').addEventListener('click', open);
    document.getElementById('closeIntegrationsModal').addEventListener('click', close);
    modal.addEventListener('click', e => {
      if (e.target === modal) close();
    });
    window.addEventListener('hashchange', () => {
      if (window.location.hash === '#integrations') open();
    });
    return () => {
      if (window.location.hash === '#integrations') open();
    };
  }

  let currentFullUrl = '';
  function setApiUrlDisplay(endpoint) {
    currentFullUrl = `${window.location.origin}${endpoint}`;
    const apiEl = document.getElementById('apiUrl');
    if (apiEl) apiEl.textContent = currentFullUrl;
  }


  // Theme: follows the OS until the visitor picks one with the toggle.
  const THEME_KEY = 'dap_theme';
  function isDarkTheme() {
    return document.documentElement.classList.contains('dark');
  }
  function storedTheme() {
    try {
      return localStorage.getItem(THEME_KEY);
    } catch {
      return null;
    }
  }
  function applyTheme(dark) {
    document.documentElement.classList.toggle('dark', dark);
    if (lastChartArgs) renderChart(...lastChartArgs);
  }
  function bindTheme() {
    document.getElementById('themeBtn')?.addEventListener('click', () => {
      const dark = !isDarkTheme();
      try {
        localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light');
      } catch {
        /* ignore quota / disabled storage */
      }
      applyTheme(dark);
    });
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (!storedTheme()) applyTheme(e.matches);
    });
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

  function updatePriceStats(labels, series, _unit) {
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

    // Format hour-aligned values as "14h"; quarter values keep full "HH:MM" so 14:15 ≠ 14:00.
    const formatTime = (time) => {
      if (!time || time === '--') return '--';
      const [h, m] = time.split(':');
      return m === '00' ? `${h}h` : `${h}:${m}`;
    };

    const lowestTime = formatTime(labels[minIndex]);
    const highestTime = formatTime(labels[maxIndex]);

    // Update with compact format: [icon] €0.131 at 14h
    document.getElementById('lowestPriceLabel').innerHTML =
      `<svg class="w-3 h-3 inline mr-1 text-green-600" fill="currentColor" viewBox="0 0 20 20">
        <path fill-rule="evenodd" d="M14.707 12.293a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 111.414-1.414L10 15.586l3.293-3.293a1 1 0 011.414 0z" clip-rule="evenodd"/>
      </svg>€${minPrice.toFixed(3)} at ${lowestTime}`;

    document.getElementById('highestPriceLabel').innerHTML =
      `<svg class="w-3 h-3 inline mr-1 text-red-600" fill="currentColor" viewBox="0 0 20 20">
        <path fill-rule="evenodd" d="M5.293 7.707a1 1 0 010-1.414l4-4a1 1 0 011.414 0l4 4a1 1 0 01-1.414 1.414L10 4.414 6.707 7.707a1 1 0 01-1.414 0z" clip-rule="evenodd"/>
      </svg>€${maxPrice.toFixed(3)} at ${highestTime}`;

    document.getElementById('averagePriceLabel').innerHTML =
      `<svg class="w-3 h-3 inline mr-1 text-blue-600" fill="currentColor" viewBox="0 0 20 20">
        <path fill-rule="evenodd" d="M3 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clip-rule="evenodd"/>
      </svg>€${avgPrice.toFixed(3)}`;

    // Show the stats
    priceStatsEl.classList.remove('hidden');
  }

  // Fractional x-axis position of the current time, or null when it's outside the data.
  function nowPosition(times, resolutionMinutes, now = Date.now()) {
    const starts = times.map(t => new Date(t).getTime());
    const last = starts.length - 1;
    if (last < 0 || now < starts[0] || now >= starts[last] + resolutionMinutes * 60000) return null;
    for (let i = last; i >= 0; i--) {
      if (now >= starts[i]) return i === last ? last : i + (now - starts[i]) / (starts[i + 1] - starts[i]);
    }
    return null;
  }

  function nowMarkerPlugin(times, resolutionMinutes, color) {
    return {
      id: 'nowMarker',
      afterDatasetsDraw(chartInstance) {
        const position = nowPosition(times, resolutionMinutes);
        if (position === null) return;
        const { ctx: canvas, chartArea, scales } = chartInstance;
        const x = scales.x.getPixelForValue(position);
        const labelOnLeft = x > chartArea.right - 40;
        canvas.save();
        canvas.strokeStyle = color;
        canvas.fillStyle = color;
        canvas.lineWidth = 1.5;
        canvas.setLineDash([4, 4]);
        canvas.beginPath();
        canvas.moveTo(x, chartArea.top);
        canvas.lineTo(x, chartArea.bottom);
        canvas.stroke();
        canvas.font = `600 11px ${Chart.defaults.font.family}`;
        canvas.textAlign = labelOnLeft ? 'right' : 'left';
        canvas.textBaseline = 'top';
        canvas.fillText('Now', x + (labelOnLeft ? -5 : 5), chartArea.top + 3);
        canvas.restore();
      }
    };
  }

  // The prices on screen, which the cheapest start is worked out from. Null when no prices are showing.
  let displayed = null;
  let cheapestWindow = null;

  function localTime(iso) {
    return new Date(iso).toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: displayed.timezone
    });
  }

  function cheapestWindowLines() {
    return [
      CheapestStart.startLabel(cheapestWindow.delayHours),
      `${localTime(cheapestWindow.start)}\u2013${localTime(cheapestWindow.end)}`,
      `avg \u20ac${cheapestWindow.averagePrice.toFixed(3)}`
    ];
  }

  function noWindowMessage() {
    const length = CheapestStart.formatLength(Number(els.cheapestLength.value));
    if (displayed.timeframe === 'today') return `A ${length} run no longer fits before midnight. Try Next 24h.`;
    if (displayed.timeframe === 'tomorrow') {
      return `A ${length} run tomorrow is out of reach of a 20-hour delay. Try Next 24h.`;
    }
    return `Not enough prices are known yet for a ${length} run.`;
  }

  // Runs on load, on a new length and every minute, because the possible start times move with the clock.
  function updateCheapestStart() {
    if (!displayed) return;
    cheapestWindow = CheapestStart.findCheapestStart(displayed.prices, {
      lengthMinutes: Number(els.cheapestLength.value),
      resolutionMinutes: displayed.resolutionMinutes,
      nowMs: Date.now()
    });
    const notices = [warningMessages(displayed.warnings), cheapestWindow ? '' : noWindowMessage()];
    setNotice('warning', notices.filter(Boolean).join(' '));
    document.getElementById('cheapestSummary').textContent = cheapestWindow
      ? `Cheapest: ${cheapestWindowLines().join(', ')}.`
      : '';
  }

  function cheapestWindowPlugin(dark) {
    // The chart gives the last price no width, so a window reaching into it stops at the right edge.
    function bandEdges(chartInstance) {
      const times = displayed.prices.map(p => p.time);
      const lastStart = new Date(times[times.length - 1]).getTime();
      const pixel = iso => {
        const position = nowPosition(times, displayed.resolutionMinutes, Math.min(new Date(iso).getTime(), lastStart));
        return chartInstance.scales.x.getPixelForValue(position);
      };
      return { left: pixel(cheapestWindow.start), right: pixel(cheapestWindow.end) };
    }

    return {
      id: 'cheapestWindow',
      beforeDatasetsDraw(chartInstance) {
        if (!cheapestWindow) return;
        const { ctx: canvas, chartArea } = chartInstance;
        const { left, right } = bandEdges(chartInstance);
        canvas.save();
        canvas.fillStyle = dark ? 'rgba(52, 211, 153, 0.22)' : 'rgba(16, 185, 129, 0.2)';
        canvas.fillRect(left, chartArea.top, Math.max(right - left, 2), chartArea.bottom - chartArea.top);
        canvas.restore();
      },
      afterDatasetsDraw(chartInstance) {
        if (!cheapestWindow) return;
        const { ctx: canvas, chartArea } = chartInstance;
        const { left, right } = bandEdges(chartInstance);
        const lines = cheapestWindowLines();
        const font = i => `${i === 0 ? '700 13px' : '400 12px'} ${Chart.defaults.font.family}`;
        canvas.save();
        canvas.font = font(0);
        const halfWidth = Math.max(...lines.map(line => canvas.measureText(line).width)) / 2;
        // A short window's text runs past its band, but stays on the chart.
        const x = Math.min(Math.max((left + right) / 2, chartArea.left + halfWidth), chartArea.right - halfWidth);
        // Stay clear of the "Now" label, which sits beside its line at the top of the chart.
        const nowAt = displayed.timeframe === 'today'
          ? nowPosition(displayed.prices.map(p => p.time), displayed.resolutionMinutes)
          : null;
        const nowX = nowAt === null ? null : chartInstance.scales.x.getPixelForValue(nowAt);
        const nearNow = nowX !== null && nowX > x - halfWidth - 40 && nowX < x + halfWidth + 40;
        const top = chartArea.top + (nearNow ? 20 : 4);
        canvas.textAlign = 'center';
        canvas.textBaseline = 'top';
        canvas.lineJoin = 'round';
        canvas.lineWidth = 3;
        canvas.strokeStyle = dark ? '#111827' : '#ffffff';
        canvas.fillStyle = dark ? '#6ee7b7' : '#065f46';
        lines.forEach((line, i) => {
          canvas.font = font(i);
          canvas.strokeText(line, x, top + i * 16);
          canvas.fillText(line, x, top + i * 16);
        });
        canvas.restore();
      }
    };
  }

  const WIND_SOLAR_LABEL = 'Wind + solar';

  function renderChart(labels, series, unit, resolutionMinutes = 60, nowMarkerTimes = null, windSolarSeries = null) {
    const ctx = document.getElementById('priceChart');
    lastChartArgs = [labels, series, unit, resolutionMinutes, nowMarkerTimes, windSolarSeries];

    if (chart) {
      chart.destroy();
    }

    const { min1, min2, max1, max2 } = highlightExtremes(series);

    // Colors
    const dark = isDarkTheme();
    Chart.defaults.color = dark ? '#9ca3af' : '#666';
    Chart.defaults.borderColor = dark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)';
    const COLOR_CHEAPEST = dark ? '#34d399' : '#065f46'; // dark green, bright on a dark background
    const COLOR_SECOND_CHEAPEST = dark ? '#a7f3d0' : '#10b981'; // light green (emerald)
    const COLOR_MID = '#eab308'; // yellow
    const COLOR_SECOND_EXPENSIVE = '#f59e0b'; // orange
    const COLOR_MOST_EXPENSIVE = dark ? '#ef4444' : '#7f1d1d'; // dark red, bright on a dark background

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
      plugins: [
        cheapestWindowPlugin(dark),
        ...(nowMarkerTimes ? [nowMarkerPlugin(nowMarkerTimes, resolutionMinutes, dark ? '#60a5fa' : '#2563eb')] : [])
      ],
      data: {
        labels,
        datasets: [
          {
            label: `Price (${unit})`,
            data: series,
            borderColor: dark ? 'rgb(229, 231, 235)' : 'rgb(17, 24, 39)',
            backgroundColor: dark ? 'rgba(229, 231, 235, 0.08)' : 'rgba(17, 24, 39, 0.08)',
            fill: true,
            tension: 0.35,
            pointBackgroundColor: pointBackground,
            pointRadius,
            borderWidth: 2
          },
          ...(windSolarSeries
            ? [
              {
                label: WIND_SOLAR_LABEL,
                data: windSolarSeries,
                yAxisID: 'windSolar',
                borderColor: dark ? '#34d399' : '#059669',
                backgroundColor: dark ? '#34d399' : '#059669',
                tension: 0.35,
                pointRadius: 0,
                borderWidth: 2
              }
            ]
            : [])
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        // The share line has no points to hover over, so show both values for the hovered time.
        ...(windSolarSeries && { interaction: { mode: 'index', intersect: false } }),
        plugins: {
          legend: { display: Boolean(windSolarSeries), labels: { boxHeight: 2 } },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const v = ctx.parsed.y;
                if (ctx.dataset.yAxisID === 'windSolar') return ` ${WIND_SOLAR_LABEL}: ${v.toFixed(1)}%`;
                return ` ${v.toFixed(5)} ${unit}`;
              }
            }
          }
        },
        scales: {
          x: {
            ticks: {
              maxRotation: 0,
              autoSkip: true,
              callback: (_, idx) => {
                const lbl = labels[idx];
                // For 15-min data, only show HH:00 marks to keep the axis readable.
                if (resolutionMinutes === 15 && lbl && !lbl.endsWith(':00')) return '';
                return lbl;
              }
            }
          },
          y: {
            title: { display: true, text: unit },
            ticks: { precision: 5 }
          },
          ...(windSolarSeries && {
            windSolar: {
              position: 'right',
              beginAtZero: true,
              grid: { drawOnChartArea: false },
              // Phones have no room for it beside the chart.
              title: { display: window.innerWidth >= 640, text: '% of forecast demand' },
              ticks: { callback: value => `${value}%` }
            }
          })
        }
      }
    });
  }

  async function fetchJSON(url) {
    const res = await fetch(url, { headers: { 'accept': 'application/json' } });
    if (!res.ok) {
      const err = new Error(`Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
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
      const vatPercent = Number((country.defaultVat * 100).toFixed(1));
      els.vatPercent.value = vatPercent.toString();
    }
  }

  const NOTICE_BASE = 'mb-3 shrink-0 rounded border px-3 py-2 text-xs';
  const NOTICE_STYLES = {
    error: `${NOTICE_BASE} bg-red-50 border-red-200 text-red-900`,
    warning: `${NOTICE_BASE} bg-yellow-50 border-yellow-200 text-yellow-800`
  };
  const WARNING_MESSAGES = {
    fallback_source: 'These prices come from our fallback source (Stekker), so they may be less accurate.',
    stale_data: 'We couldn\'t refresh prices just now, so these may be out of date.',
    incomplete_data: 'Prices are missing for part of today.',
    wind_solar_unavailable: 'The wind and solar forecast is unavailable right now. Prices aren\'t affected.'
  };

  function setNotice(kind, message) {
    els.status.className = message ? NOTICE_STYLES[kind] : '';
    els.status.textContent = message || '';
  }

  function warningMessages(warnings) {
    return (warnings || []).map(w => WARNING_MESSAGES[w.split(':')[0]] || w).join(' ');
  }

  // A chart for the previous selection would look like the answer to the current one.
  function clearChart() {
    if (chart) chart.destroy();
    chart = null;
    lastChartArgs = null;
    displayed = null;
    cheapestWindow = null;
    document.getElementById('cheapestSummary').textContent = '';
    document.getElementById('priceStats').classList.add('hidden');
  }

  function loadErrorMessage(err) {
    if (err.status === 400) return 'Prices can\'t be calculated with these values. Check your VAT and markup.';
    return 'We couldn\'t load prices. Please try again in a moment.';
  }

  async function refresh() {
    const requestId = ++latestRequestId;
    try {
      const country = els.country.value || 'nl';
      const timeframe = els.timeframe.value || 'next24h';
      const markupCents = els.markupCents.value || '0';
      const vatPercent = els.vatPercent.value || '0';
      const interval = els.interval.value || '60M';
      const includeWindSolar = els.windSolar.checked;
      els.windSolarNote.classList.toggle('hidden', !includeWindSolar);

      const endpoint = buildEndpoint({ country, timeframe, markupCents, vatPercent, interval, includeWindSolar });
      setApiUrlDisplay(endpoint);

      const payload = await fetchJSON(endpoint);
      if (requestId !== latestRequestId) return;
      const unit = payload?.info?.priceUnit || 'EUR/kWh';
      const resolutionMinutes = payload?.info?.resolutionMinutes || 60;

      const labels = (payload?.data || []).map(p => p.hour ?? new Date(p.time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }));
      const series = (payload?.data || []).map(p => Number(p.price));
      const windSolarSeries = includeWindSolar ? payload.data.map(p => p.windSolarShare ?? null) : null;

      if (series.length === 0) {
        clearChart();
        setNotice('warning', 'No prices are available for this selection yet.');
        return;
      }

      const nowMarkerTimes = payload?.info?.type === 'today' ? payload.data.map(p => p.time) : null;
      displayed = {
        prices: payload.data.map(p => ({ time: p.time, price: Number(p.price) })),
        resolutionMinutes,
        timezone: payload?.info?.timezone,
        timeframe,
        warnings: payload?.warnings
      };
      updateCheapestStart();
      updatePriceStats(labels, series, unit);
      renderChart(labels, series, unit, resolutionMinutes, nowMarkerTimes, windSolarSeries);
    } catch (err) {
      console.error(err);
      if (requestId !== latestRequestId) return;
      clearChart();
      setNotice('error', loadErrorMessage(err));
    }
  }

  function setPillActive(activeBtn, ...inactiveBtns) {
    activeBtn.classList.add('bg-black','text-white','hover:bg-gray-800');
    activeBtn.classList.remove('text-gray-700','hover:bg-gray-50');
    activeBtn.setAttribute('aria-pressed','true');
    inactiveBtns.forEach(btn => {
      btn.classList.remove('bg-black','text-white','hover:bg-gray-800');
      btn.classList.add('text-gray-700','hover:bg-gray-50');
      btn.setAttribute('aria-pressed','false');
    });
  }

  const TIMEFRAME_BUTTONS = { next24h: 'tfNext24h', today: 'tfToday', tomorrow: 'tfTomorrow' };

  function setTimeframe(which) {
    els.timeframe.value = which;
    const others = Object.keys(TIMEFRAME_BUTTONS).filter(key => key !== which);
    setPillActive(
      document.getElementById(TIMEFRAME_BUTTONS[which]),
      ...others.map(key => document.getElementById(TIMEFRAME_BUTTONS[key]))
    );
  }

  // Tomorrow's button only works once its prices are out. A failed check changes nothing.
  let latestTomorrowCheck = 0;
  async function updateTomorrowAvailability() {
    const checkId = ++latestTomorrowCheck;
    let available;
    try {
      const payload = await fetchJSON(`/api/${els.country.value}/tomorrow`);
      available = payload.data.length > 0;
    } catch (err) {
      console.error(err);
      return;
    }
    if (checkId !== latestTomorrowCheck) return;
    document.getElementById('tfTomorrow').disabled = !available;
    if (!available && els.timeframe.value === 'tomorrow') {
      setTimeframe('next24h');
      saveState();
      refresh();
    }
  }

  function setIntervalActive(which) {
    const btnHourly = document.getElementById('intvHourly');
    const btn15M = document.getElementById('intv15M');
    if (which === '15M') setPillActive(btn15M, btnHourly);
    else setPillActive(btnHourly, btn15M);
  }

  function bindEvents() {
    // Country and inputs
    els.country.addEventListener('change', () => {
      updateVatForCountry(els.country.value);
      saveState();
      refresh();
      updateTomorrowAvailability();
    });
    els.markupCents.addEventListener('input', () => { saveState(); refresh(); });
    els.vatPercent.addEventListener('input', () => { saveState(); refresh(); });
    els.windSolar.addEventListener('change', () => { saveState(); refresh(); });
    els.cheapestLength.addEventListener('change', () => {
      saveState();
      updateCheapestStart();
      if (chart) chart.draw();
    });

    // Clear buttons. Zero rather than empty, because an empty saved VAT falls back to the country default on reload.
    [['clearVat', els.vatPercent], ['clearMarkup', els.markupCents]].forEach(([id, input]) => {
      document.getElementById(id)?.addEventListener('click', () => {
        input.value = '0';
        input.focus();
        saveState();
        refresh();
      });
    });

    openIntegrationsFromHash = setupIntegrationsModal();

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
    Object.entries(TIMEFRAME_BUTTONS).forEach(([timeframe, id]) => {
      document.getElementById(id).addEventListener('click', () => {
        setTimeframe(timeframe);
        saveState();
        refresh();
      });
    });

    // Interval (resolution) switch
    const btnHourly = document.getElementById('intvHourly');
    const btn15M = document.getElementById('intv15M');
    btnHourly?.addEventListener('click', () => {
      els.interval.value = '60M';
      setIntervalActive('60M');
      saveState();
      refresh();
    });
    btn15M?.addEventListener('click', () => {
      els.interval.value = '15M';
      setIntervalActive('15M');
      saveState();
      refresh();
    });

    // Copy button
    const copyBtn = document.getElementById('copyBtn');
    copyBtn?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(currentFullUrl || '');
        const original = copyBtn.innerHTML;
        copyBtn.textContent = 'Copied!';
        setTimeout(() => (copyBtn.innerHTML = original), 1000);
      } catch (e) {
        console.error('Copy failed', e);
      }
    });
  }

  // Lengths offered for the cheapest start, in minutes: every 15 minutes up to 12 hours.
  const CHEAPEST_LENGTHS = Array.from({ length: 48 }, (_, i) => (i + 1) * 15);
  const DEFAULT_CHEAPEST_LENGTH = 240;

  // Local storage
  const LS_KEY = 'dap_ui_state_v1';
  function saveState() {
    try {
      const state = {
        country: els.country.value,
        timeframe: els.timeframe.value,
        markupCents: els.markupCents.value,
        vatPercent: els.vatPercent.value,
        interval: els.interval.value,
        windSolar: els.windSolar.checked,
        cheapestLength: els.cheapestLength.value
      };
      localStorage.setItem(LS_KEY, JSON.stringify(state));
    } catch {
      /* ignore quota / disabled storage */
    }
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
    document.getElementById('year').textContent = new Date().getFullYear();
    bindTheme();
    bindEvents();
    fillOptions(els.cheapestLength, CHEAPEST_LENGTHS, CheapestStart.formatLength, DEFAULT_CHEAPEST_LENGTH);
    // Keep the "Now" marker and the cheapest start moving while the page stays open.
    setInterval(() => {
      updateCheapestStart();
      if (chart) chart.draw();
    }, 60000);
    setInterval(updateTomorrowAvailability, 10 * 60000);
    try {
      await loadCountries();
    } catch (err) {
      console.error(err);
      setNotice('error', loadErrorMessage(err));
      return;
    }
    const saved = loadState();
    if (saved) {
      if (saved.country) {
        els.country.value = saved.country;
        updateVatForCountry(saved.country);
      }
      if (saved.markupCents) els.markupCents.value = saved.markupCents;
      if (saved.vatPercent) els.vatPercent.value = saved.vatPercent;
      setTimeframe(TIMEFRAME_BUTTONS[saved.timeframe] ? saved.timeframe : 'next24h');
      els.interval.value = saved.interval || '60M';
      setIntervalActive(els.interval.value);
      els.windSolar.checked = saved.windSolar === true;
      if (CHEAPEST_LENGTHS.includes(Number(saved.cheapestLength))) els.cheapestLength.value = saved.cheapestLength;
    } else {
      // Default to next24h and Netherlands VAT
      setTimeframe('next24h');
      els.interval.value = '60M';
      setIntervalActive('60M');
      updateVatForCountry('nl');
    }
    openIntegrationsFromHash();
    await updateTomorrowAvailability();
    await refresh();
  }

  document.addEventListener('DOMContentLoaded', init);
})();

