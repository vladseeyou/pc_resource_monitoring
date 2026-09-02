'use strict';

const POLL_MS = 1500;
const WINDOW = 48;

const histLabels = [];
const hostHist = new Map(); // instance -> { cpu, mem, tCpu }

const el = (id) => document.getElementById(id);
const dot = el('dot');
const statusText = el('statusText');
const lastUpdate = el('lastUpdate');
const fleetCount = el('fleetCount');

const PALETTE = {
  cpu: ['#67e8f9', '#06b6d4'],
  mem: ['#86efac', '#22c55e'],
  gpu: ['#e879f9', '#a855f7'],
  warn: ['#fde047', '#f59e0b'],
  crit: ['#fb7185', '#ef4444']
};

const CORE_COLORS = { ok: '#22d3ee', warn: '#f59e0b', crit: '#ef4444' };

const MEM_COLOR = '#22c55e';
const GPU_COLOR = '#a855f7';

let charts = null; // comparison charts { mode, cpuChart, memChart, tempChart }
let consecutiveErrors = 0;
let gaugeSeq = 0;

// instance -> { panel, dot, title, role, load, nodata, panelBody, gaugesContainer,
//               tCpuWrap, tGpuWrap, canvas, noData, coreBars, chart, cpuGauge, memGauge, gpuGauges }
const hostEls = new Map();

let fleet = []; // [{ role, instance, displayName, color, visible, status, data, lastSuccessAt, error }]

// instance -> { chip, nameEl, stateEl, cls, name, state, color } (reconciled fleet chips)
const fleetChips = new Map();
// instance -> "cpu|mem" signature of the series currently painted on the per-host chart
const hostChartSig = new Map();
// signature of the visible-host series + legend inputs behind the last comparison-chart paint
let cmpSig = null;

function cmpSignature(vis) {
  return vis.map((h) => {
    const hh = getHostHist(h.instance);
    return h.instance + '\u0000' + h.displayName + '\u0000' + h.color +
      '\u0001' + hh.cpu.join(',') + '\u0002' + hh.mem.join(',') + '\u0003' + hh.tCpu.join(',');
  }).join('\u0004');
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function hostColor(instance, isLocal) {
  if (isLocal) return '#22d3ee';
  const h = hashStr(instance) % 360;
  return `hsl(${h}, 82%, 64%)`;
}

function stateOf(pct) {
  if (!Number.isFinite(pct)) return 'ok';
  if (pct > 85) return 'crit';
  if (pct >= 60) return 'warn';
  return 'ok';
}

function fmt(n, digits = 1) {
  return Number.isFinite(n) ? n.toFixed(digits) : '--';
}

function gb(mb) {
  return Number.isFinite(mb) ? (mb / 1024).toFixed(1) : '--';
}

function shortName(name) {
  const parts = String(name || 'GPU').split(/\s+/);
  return parts.length > 3 ? parts.slice(-3).join(' ') : parts.join(' ');
}

function clockStr(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return '--:--:--';
  return d.toLocaleTimeString([], { hour12: false });
}

const trim = (a) => { if (a.length > WINDOW) a.splice(0, a.length - WINDOW); };

function getHostHist(instance) {
  if (!hostHist.has(instance)) hostHist.set(instance, { cpu: [], mem: [], tCpu: [] });
  return hostHist.get(instance);
}

function buildHosts(data) {
  const out = [];
  const local = (data && data.local) || {};
  const lh = local.hostname || 'localhost';
  const localName = local.instance || lh;
  out.push({
    role: 'local', instance: lh, displayName: localName + ' (LOCAL)',
    color: '#22d3ee', visible: true, status: 'ok', data: local,
    lastSuccessAt: data && data.timestamp, error: null
  });
  const remotes = Array.isArray(data && data.hosts) ? data.hosts : [];
  for (const h of remotes) {
    const inst = h.instance || h.url || 'unknown';
    const remoteName = (h.data && h.data.instance) || inst;
    out.push({
      role: 'remote', instance: inst, displayName: remoteName, color: hostColor(inst),
      visible: h.status === 'ok', status: h.status || 'error',
      data: h.data || null, lastSuccessAt: h.lastSuccessAt || null, error: h.error || null
    });
  }
  return out;
}

/* ---------------- gauges ---------------- */

function appendMini(container, label, color) {
  const tpl = document.getElementById('miniGaugeTpl');
  const node = tpl.content.firstElementChild.cloneNode(true);
  const gid = 'g' + (++gaugeSeq);
  const grad = node.querySelector('.gradx');
  grad.id = gid;
  node.querySelector('.progress').setAttribute('stroke', `url(#${gid})`);
  node.querySelector('.label').textContent = label;
  node.querySelector('.sub').textContent = '';
  container.appendChild(node);
  return { card: node, valueEl: node.querySelector('.value'), subEl: node.querySelector('.sub'), color };
}

function setMini(m, pct) {
  const clamped = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
  m.valueEl.textContent = fmt(pct);
  m.card.querySelector('.progress').style.strokeDashoffset = String(100 - clamped);
  m.card.style.setProperty('--g1', m.color);
  m.card.style.setProperty('--g2', m.color);
}

function setTempChip(wrap, ok, value) {
  const valEl = wrap.querySelector('.value');
  if (!ok || !Number.isFinite(value)) {
    wrap.className = 'temp-chip st-na';
    valEl.textContent = 'N/A';
    return;
  }
  const st = value >= 85 ? 'st-crit' : value >= 65 ? 'st-warn' : 'st-ok';
  wrap.className = 'temp-chip ' + st;
  valEl.textContent = `${value.toFixed(1)} \u00b0C`;
}

/* ---------------- per-host panels ---------------- */

function createPanel(h) {
  const tpl = document.getElementById('hostPanelTpl');
  const node = tpl.content.firstElementChild.cloneNode(true);
  hostEls.set(h.instance, {
    panel: node,
    dot: node.querySelector('.panel-dot'),
    title: node.querySelector('.panel-title'),
    role: node.querySelector('.panel-role'),
    load: node.querySelector('.panel-load'),
    nodata: node.querySelector('.panel-nodata'),
    panelBody: node.querySelector('.panel-body'),
    gaugesContainer: node.querySelector('.panel-gauges'),
    tCpuWrap: node.querySelector('.t-cpu'),
    tGpuWrap: node.querySelector('.t-gpu'),
    canvas: node.querySelector('.panel-chart canvas'),
    noData: node.querySelector('.mini-nd'),
    coreBars: node.querySelector('.core-bars.compact'),
    chart: null, cpuGauge: null, memGauge: null, gpuGauges: []
  });
  node.style.setProperty('--hc', h.color);
  node.style.display = h.visible ? '' : 'none';
  el('hostPanels').appendChild(node);
}

function reconcilePanels() {
  const want = new Set(fleet.map((h) => h.instance));
  for (const inst of [...hostEls.keys()]) {
    if (!want.has(inst)) {
      const r = hostEls.get(inst);
      if (r.chart && r.chart.destroy) r.chart.destroy();
      r.panel.remove();
      hostEls.delete(inst);
      hostChartSig.delete(inst);
    }
  }
  fleet.forEach((h) => { if (!hostEls.has(h.instance)) createPanel(h); });
}

function updatePanel(h) {
  const r = hostEls.get(h.instance);
  if (!r) return;
  r.panel.style.setProperty('--hc', h.color);
  r.panel.style.display = h.visible ? '' : 'none';
  r.dot.className = 'dot panel-dot ' + (h.status === 'ok' ? 'ok' : 'err');
  r.title.textContent = h.displayName;
  r.role.textContent = h.role === 'local' ? 'LOCAL' : 'REMOTE';
  r.role.style.setProperty('--hc', h.color);

  if (h.status !== 'ok' || !h.data) {
    r.nodata.classList.add('show');
    r.panelBody.classList.add('hide');
    const parts = ['NO DATA'];
    if (h.error) parts.push(`<span class="nd-sep">\u00b7</span>${esc(h.error)}`);
    if (h.lastSuccessAt) parts.push(`LAST SUCCESS ${clockStr(h.lastSuccessAt)}`);
    r.nodata.innerHTML = parts.join('');
    return;
  }

  const d = h.data;
  r.nodata.classList.remove('show');
  r.panelBody.classList.remove('hide');

  const cpuPct = Number((d.cpu && d.cpu.usagePercent) || 0);
  const cores = (d.cpu && d.cpu.cores) || '--';
  const memPct = Number((d.memory && d.memory.percentUsed) || 0);
  const gpus = Array.isArray(d.gpu) ? d.gpu : [];
  const temps = d.temperatures || {};

  if (!r.cpuGauge) { r.cpuGauge = appendMini(r.gaugesContainer, 'CPU', h.color); }
  if (!r.memGauge) { r.memGauge = appendMini(r.gaugesContainer, 'RAM', MEM_COLOR); }
  setMini(r.cpuGauge, cpuPct);
  r.cpuGauge.subEl.textContent = `${cores} CORES`;
  setMini(r.memGauge, memPct);
  r.memGauge.subEl.textContent = `${gb(d.memory.usedMB)} / ${gb(d.memory.totalMB)} GB`;

  while (r.gpuGauges.length > gpus.length) { r.gpuGauges.pop().card.remove(); }
  while (r.gpuGauges.length < gpus.length) { r.gpuGauges.push(appendMini(r.gaugesContainer, shortName(gpus[r.gpuGauges.length].name).toUpperCase(), GPU_COLOR)); }
  gpus.forEach((gpu, i) => {
    const m = r.gpuGauges[i];
    setMini(m, Number(gpu.usagePercent));
    m.subEl.textContent = `VRAM ${gb(gpu.memUsedMB)} / ${gb(gpu.memTotalMB)} GB`;
  });

  setTempChip(r.tCpuWrap, !!temps.availability && Number.isFinite(Number(temps.cpuCelsius)), Number(temps.cpuCelsius));
  const gpuTempOk = !!temps.gpuAvailability && gpus.length > 0;
  setTempChip(r.tGpuWrap, gpuTempOk && Number.isFinite(Number(temps.gpuCelsius)), Number(temps.gpuCelsius));

  // history for this host
  const hh = getHostHist(h.instance);
  hh.cpu.push(Number.isFinite(cpuPct) ? cpuPct : null); trim(hh.cpu);
  hh.mem.push(Number.isFinite(memPct) ? memPct : null); trim(hh.mem);
  const tc = (temps.availability && Number.isFinite(Number(temps.cpuCelsius))) ? Number(temps.cpuCelsius) : null;
  hh.tCpu.push(tc === null ? null : tc); trim(hh.tCpu);

  drawPerHost(r, h, hh);
  updateCoreBars(r.coreBars, Array.isArray(d.cpu && d.cpu.perCoreUsagePercent) ? d.cpu.perCoreUsagePercent.map(Number) : []);
}

function drawPerHost(r, h, hh) {
  const sig = hh.cpu.join(',') + '|' + hh.mem.join(',');
  if (window.Chart && !window.__NO_CHART__) {
    if (!r.chart) {
      r.chart = new Chart(r.canvas, {
        type: 'line',
        data: {
          labels: histLabels,
          datasets: [
            Object.assign(lineDataset('CPU', h.color), { data: hh.cpu }),
            Object.assign(lineDataset('RAM', MEM_COLOR), { data: hh.mem })
          ]
        },
        options: chartOptions(100, false)
      });
      r.chart.update('none');
      hostChartSig.set(h.instance, sig);
    } else if (hostChartSig.get(h.instance) === sig) {
      return;
    } else {
      r.chart.data.labels = histLabels;
      r.chart.data.datasets[0].data = hh.cpu;
      r.chart.data.datasets[1].data = hh.mem;
      r.chart.update('none');
      hostChartSig.set(h.instance, sig);
    }
  } else {
    if (hostChartSig.get(h.instance) === sig) return;
    const finite = hh.cpu.concat(hh.mem).filter((v) => Number.isFinite(v));
    r.noData.classList.toggle('show', finite.length < 2);
    spark(r.canvas, [hh.cpu, hh.mem], null, 0, 100, [h.color, MEM_COLOR]);
    hostChartSig.set(h.instance, sig);
  }
}

/* ---------------- fleet toggle bar ---------------- */

function renderFleet() {
  const bar = el('hostBar');
  const want = new Set(fleet.map((h) => h.instance));
  for (const inst of [...fleetChips.keys()]) {
    if (!want.has(inst)) {
      fleetChips.get(inst).chip.remove();
      fleetChips.delete(inst);
    }
  }
  fleet.forEach((h) => {
    const inst = h.instance;
    let rec = fleetChips.get(inst);
    if (!rec) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.innerHTML = '<span class="chip-dot"></span><span class="chip-name"></span><span class="chip-state"></span>';
      chip.style.setProperty('--hc', h.color);
      chip.addEventListener('click', () => {
        const cur = fleet.find((x) => x.instance === inst);
        if (!cur) return;
        cur.visible = !cur.visible; reconcilePanels(); renderFleet(); applyVisibility(); updateComparisonCharts();
      });
      rec = { chip, nameEl: chip.querySelector('.chip-name'), stateEl: chip.querySelector('.chip-state'), cls: null, name: null, state: null, color: h.color };
      fleetChips.set(inst, rec);
      bar.appendChild(chip);
    }
    const cls = 'chip' + (h.status === 'error' ? ' err' : '') + (h.visible ? '' : ' off');
    if (rec.cls !== cls) { rec.chip.className = cls; rec.cls = cls; }
    if (rec.color !== h.color) { rec.chip.style.setProperty('--hc', h.color); rec.color = h.color; }
    if (rec.name !== h.displayName) { rec.nameEl.textContent = h.displayName; rec.name = h.displayName; }
    const state = h.status === 'ok' ? 'LIVE' : 'ERR';
    if (rec.state !== state) { rec.stateEl.textContent = state; rec.state = state; }
  });
  const vis = fleet.filter((h) => h.visible).length;
  fleetCount.textContent = `${vis} / ${fleet.length} HOSTS`;
}

function applyVisibility() {
  fleet.forEach((h) => { const r = hostEls.get(h.instance); if (r) r.panel.style.display = h.visible ? '' : 'none'; });
}

/* ---------------- comparison charts ---------------- */

function visibleOk() {
  return fleet.filter((h) => h.visible && h.status === 'ok' && h.data);
}

function cmpDatasets(kind) {
  return visibleOk().map((h) => {
    const series = kind === 'mem' ? getHostHist(h.instance).mem : getHostHist(h.instance).tCpu;
    const color = kind === 'mem' ? MEM_COLOR : h.color;
    const label = kind === 'mem' ? h.displayName + ' MEM' : (h.displayName + ' \u00b0C');
    return Object.assign(lineDataset(label, color), { data: series });
  });
}

function setLegends() {
  const vis = visibleOk();
  const html = vis.map((h) => `<span><i style="--lc:${h.color}"></i>${esc(h.displayName)}</span>`).join('');
  el('cpuLegend').innerHTML = html;
  el('memLegend').innerHTML = vis.map((h) => `<span><i style="--lc:${MEM_COLOR}"></i>${esc(h.displayName)}</span>`).join('');
  el('tempLegend').innerHTML = vis.map((h) => `<span><i style="--lc:${h.color}"></i>${esc(h.displayName)} \u00b0C</span>`).join('');
}

function initCharts() {
  if (window.Chart && !window.__NO_CHART__) {
    Chart.defaults.font.family = '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace';
    const cpuChart = new Chart(el('cpuChart'), { type: 'line', data: { labels: [], datasets: [] }, options: chartOptions(100, false) });
    const memChart = new Chart(el('memChart'), { type: 'line', data: { labels: [], datasets: [] }, options: chartOptions(100, false) });
    const tempChart = new Chart(el('tempChart'), { type: 'line', data: { labels: [], datasets: [] }, options: chartOptions(undefined, false) });
    charts = { mode: 'chartjs', cpuChart, memChart, tempChart };
    el('chartMode').textContent = 'CHART ENGINE: CHART.JS';
  } else {
    charts = { mode: 'fallback' };
    el('chartMode').textContent = 'CHART ENGINE: BUILTIN FALLBACK (CDN UNAVAILABLE)';
  }
}

function updateComparisonCharts() {
  if (!charts) initCharts();
  const vis = visibleOk();
  const anyTemp = vis.some((h) => getHostHist(h.instance).tCpu.some((v) => Number.isFinite(v)));
  el('tempNoData').classList.toggle('show', !anyTemp && histLabels.length >= 4);

  const sig = cmpSignature(vis);
  if (sig === cmpSig) return;
  cmpSig = sig;

  if (charts.mode === 'chartjs') {
    charts.cpuChart.data.datasets = cmpDatasets('cpu');
    charts.cpuChart.update('none');
    charts.memChart.data.datasets = cmpDatasets('mem');
    charts.memChart.update('none');
    charts.tempChart.data.datasets = cmpDatasets('temp');
    charts.tempChart.update('none');
  } else {
    const cpuSeries = vis.map((h) => getHostHist(h.instance).cpu);
    spark(el('cpuChart'), cpuSeries, null, 0, 100, vis.map((h) => h.color));
    spark(el('memChart'), vis.map((h) => getHostHist(h.instance).mem), null, 0, 100, vis.map(() => MEM_COLOR));
    const tSeries = vis.map((h) => getHostHist(h.instance).tCpu);
    const all = tSeries.flat().filter((v) => Number.isFinite(v));
    const top = all.length ? Math.max(60, Math.ceil(Math.max(...all) * 1.2 / 10) * 10) : 100;
    spark(el('tempChart'), tSeries, null, 0, top, vis.map((h) => h.color));
  }
  setLegends();
}

/* ---------------- charts helpers (reused) ---------------- */

function areaGradient(hex) {
  return (context) => {
    const chart = context.chart;
    const area = chart.chartArea;
    if (!area) return `${hex}33`;
    const g = chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
    g.addColorStop(0, `${hex}66`);
    g.addColorStop(1, `${hex}05`);
    return g;
  };
}

function lineDataset(label, color) {
  return {
    label, data: [], borderColor: color, borderWidth: 2, pointRadius: 0,
    tension: 0.35, fill: true, backgroundColor: areaGradient(color), spanGaps: false
  };
}

function baseScales(yMax) {
  return {
    x: { grid: { color: 'rgba(148, 163, 184, 0.07)' }, ticks: { color: '#5b6676', maxTicksLimit: 6, maxRotation: 0, font: { size: 9 } } },
    y: { min: 0, max: yMax, grid: { color: 'rgba(148, 163, 184, 0.07)' }, ticks: { color: '#5b6676', font: { size: 9 } } }
  };
}

function chartOptions(yMax, legend) {
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: legend ? { display: true, labels: { color: '#8b96a7', usePointStyle: true, boxWidth: 6, font: { size: 10 } } } : { display: false },
      tooltip: { backgroundColor: 'rgba(13, 17, 23, 0.92)', borderColor: 'rgba(148, 163, 184, 0.25)', borderWidth: 1, titleColor: '#e6edf3', bodyColor: '#8b96a7' }
    },
    scales: baseScales(yMax)
  };
}

const SPARK_COLORS = ['#f97316', '#e879f9', '#22d3ee', '#86efac', '#fb7185', '#fbbf24'];

function spark(canvas, seriesList, color, yMin, yMax, colors) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.1)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) { const y = (h / 4) * i + 0.5; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  const n = seriesList[0] ? seriesList[0].length : 0;
  if (n < 2) return;
  seriesList.forEach((series, si) => {
    const c = (colors && colors[si]) || color || SPARK_COLORS[si % SPARK_COLORS.length];
    const px = (i) => (i / (n - 1)) * w;
    const py = (v) => h - ((v - yMin) / (yMax - yMin)) * h;
    ctx.beginPath(); let open = false;
    for (let i = 0; i < n; i++) { const v = series[i]; if (!Number.isFinite(v)) { open = false; continue; } if (!open) { ctx.moveTo(px(i), py(v)); open = true; } else ctx.lineTo(px(i), py(v)); }
    ctx.strokeStyle = c; ctx.lineWidth = 2; ctx.stroke();
    ctx.lineTo(px(n - 1), h); ctx.lineTo(0, h); ctx.closePath();
    ctx.globalAlpha = 0.14; ctx.fillStyle = c; ctx.fill(); ctx.globalAlpha = 1;
  });
}

function updateCoreBars(coreBars, perCore) {
  if (coreBars.children.length !== perCore.length) {
    coreBars.textContent = '';
    for (let i = 0; i < perCore.length; i++) {
      const row = document.createElement('div');
      row.className = 'core-row';
      row.innerHTML = `<span class="core-id">CORE ${String(i).padStart(2, '0')}</span>` +
        '<div class="core-track"><div class="core-fill"></div></div>' + '<span class="core-pct">--</span>';
      coreBars.appendChild(row);
    }
  }
  perCore.forEach((v, i) => {
    const row = coreBars.children[i]; if (!row) return;
    const st = stateOf(v);
    const pct = Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0;
    row.querySelector('.core-fill').style.width = `${pct}%`;
    row.style.setProperty('--cc', CORE_COLORS[st]);
    row.querySelector('.core-pct').textContent = fmt(v);
  });
}

window.addEventListener('resize', () => {
  if (charts && charts.mode === 'fallback') { cmpSig = null; hostChartSig.clear(); updateComparisonCharts(); }
});

/* ---------------- poll loop ---------------- */

async function poll() {
  try {
    const res = await fetch('/api/metrics', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!charts) initCharts();

    consecutiveErrors = 0;
    dot.className = 'dot ok';
    statusText.className = 'status-text';
    statusText.textContent = 'LIVE';
    lastUpdate.textContent = clockStr(data.timestamp);
    const local = (data && data.local) || {};
    el('hostname').textContent = local.hostname || '\u2014';
    el('platform').textContent = local.platform || '?';

    fleet = buildHosts(data);
    reconcilePanels();
    renderFleet();

    fleet.forEach((h) => { if (h.visible && h.status === 'ok' && h.data) updatePanel(h); });
    applyVisibility();
    updateComparisonCharts();
  } catch (err) {
    consecutiveErrors++;
    dot.className = 'dot err';
    statusText.className = 'status-text err';
    statusText.textContent = consecutiveErrors > 1 ? `OFFLINE x${consecutiveErrors}` : 'OFFLINE';
    console.error('metrics poll failed:', err);
  } finally {
    setTimeout(poll, POLL_MS);
  }
}

poll();
