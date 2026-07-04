'use strict';

const $ = (id) => document.getElementById(id);

const els = {
  url: $('url'), concurrency: $('concurrency'),
  durationSec: $('durationSec'), maxRequests: $('maxRequests'),
  timeoutMs: $('timeoutMs'), proxyList: $('proxyList'), rotateProxy: $('rotateProxy'),
  startBtn: $('startBtn'), stopBtn: $('stopBtn'), formError: $('formError'),
  statusPill: $('statusPill'), progressBar: $('progressBar'), progressLabel: $('progressLabel'),
  stCompleted: $('stCompleted'), stInflight: $('stInflight'), stOk: $('stOk'),
  stFailed: $('stFailed'), stRps: $('stRps'), stAvgRps: $('stAvgRps'),
  stBytes: $('stBytes'), stProxies: $('stProxies'),
  stProxyAddr: $('stProxyAddr'),
  statusList: $('statusList'), errorList: $('errorList'),
  rpsChart: $('rpsChart'), okChart: $('okChart'),
};

let source = null;
let runId = null;
const rpsSeries = [];
const okRatioSeries = [];

function fmtNum(n) {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function fmt1(n) { return Number(n).toFixed(1); }

function fmtBytes(b) {
  if (b < 1024) return `${b} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { b /= 1024; i++; } while (b >= 1024 && i < u.length - 1);
  return `${b.toFixed(1)} ${u[i]}`;
}

function setStatus(state, label) {
  els.statusPill.className = `pill ${state}`;
  els.statusPill.textContent = label;
}

function codeClass(code) {
  const c = String(code);
  if (c.startsWith('2')) return 'code-2xx';
  if (c.startsWith('3')) return 'code-3xx';
  if (c.startsWith('4')) return 'code-4xx';
  if (c.startsWith('5')) return 'code-5xx';
  return '';
}

function drawChart(canvas, series, color) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const pad = 6;
  ctx.clearRect(0, 0, w, h);

  if (series.length < 2) return;
  const max = Math.max(...series, 1);
  const stepX = (w - pad * 2) / (series.length - 1);
  const scaleY = (h - pad * 2) / (max || 1);

  ctx.strokeStyle = '#2a3444';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(pad, pad); ctx.lineTo(w - pad, pad); ctx.stroke();

  ctx.beginPath();
  series.forEach((v, i) => {
    const x = pad + i * stepX;
    const y = h - pad - (v) * scaleY;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();

  const grad = ctx.createLinearGradient(0, pad, 0, h);
  grad.addColorStop(0, color + '55');
  grad.addColorStop(1, color + '00');
  ctx.lineTo(w - pad, h - pad);
  ctx.lineTo(pad, h - pad);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.fillStyle = '#7a8ba8';
  ctx.font = '10px monospace';
  ctx.fillText(String(Math.round(max)), pad + 2, pad + 10);
}

function renderTick(s) {
  els.stCompleted.textContent = fmtNum(s.completed);
  els.stInflight.textContent = fmtNum(s.inFlight);
  els.stOk.textContent = fmtNum(s.ok);
  els.stFailed.textContent = fmtNum(s.failed);
  els.stRps.textContent = fmt1(s.rps);
  els.stAvgRps.textContent = fmt1(s.avgRps);
  els.stBytes.textContent = fmtBytes(s.bytes);
  els.stProxies.textContent = fmtNum(s.proxyCount);
  els.stProxyAddr.textContent = s.proxyActive || '—';

  if (s.progress != null) {
    const pct = Math.round(s.progress * 100);
    els.progressBar.style.width = pct + '%';
    els.progressLabel.textContent = pct + '%';
  } else {
    els.progressBar.style.width = '100%';
    els.progressLabel.textContent = '\u221e';
  }

  renderDist(els.statusList, s.statusCounts, true);
  renderDist(els.errorList, s.errorCounts, false);

  rpsSeries.push(s.rps);
  const total = s.ok + s.failed;
  const ratio = total > 0 ? (s.ok / total) * 100 : 0;
  okRatioSeries.push(ratio);
  if (rpsSeries.length > 120) rpsSeries.shift();
  if (okRatioSeries.length > 120) okRatioSeries.shift();
  drawChart(els.rpsChart, rpsSeries, '#6366f1');
  drawChart(els.okChart, okRatioSeries, '#34d399');
}

function renderDist(ul, counts, isStatus) {
  const keys = Object.keys(counts || {});
  if (!keys.length) {
    ul.innerHTML = `<li class="muted">${isStatus ? 'No data yet' : 'None'}</li>`;
    return;
  }
  keys.sort((a, b) => counts[b] - counts[a]);
  ul.innerHTML = keys
    .map((k) => {
      const cls = isStatus ? codeClass(k) : 'code-5xx';
      return `<li><span class="${cls}">${k}</span><span>${fmtNum(counts[k])}</span></li>`;
    })
    .join('');
}

function toggleRunning(running) {
  els.startBtn.disabled = running;
  els.stopBtn.disabled = !running;
  [els.url, els.concurrency, els.durationSec, els.maxRequests,
   els.timeoutMs, els.proxyList, els.rotateProxy].forEach((el) => (el.disabled = running));
}

async function startTraffic() {
  els.formError.textContent = '';
  const url = els.url.value.trim();
  if (!/^https?:\/\//i.test(url)) {
    els.formError.textContent = 'Enter a valid http:// or https:// URL.';
    return;
  }

  const proxyText = els.proxyList.value.trim();
  const proxies = proxyText
    ? proxyText.split('\n').map((l) => l.trim()).filter((l) => /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+$/.test(l))
    : [];

  if (proxies.length === 0) {
    els.formError.textContent = 'No valid proxies found. Add at least one proxy (ip:port).';
    return;
  }

  const config = {
    url,
    concurrency: Number(els.concurrency.value),
    durationSec: Number(els.durationSec.value),
    maxRequests: Number(els.maxRequests.value),
    timeoutMs: Number(els.timeoutMs.value),
    proxies,
    rotateProxyEveryRequest: els.rotateProxy.checked,
  };

  rpsSeries.length = 0;
  okRatioSeries.length = 0;

  let res;
  try {
    res = await fetch('/api/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
  } catch {
    els.formError.textContent = 'Could not reach the server.';
    return;
  }
  const data = await res.json();
  if (!res.ok) {
    els.formError.textContent = data.error || 'Failed to start.';
    return;
  }

  runId = data.runId;
  toggleRunning(true);
  setStatus('running', 'Running');
  openStream(runId);
}

function openStream(id) {
  if (source) source.close();
  source = new EventSource(`/api/stream?runId=${encodeURIComponent(id)}`);

  source.addEventListener('tick', (e) => renderTick(JSON.parse(e.data)));
  source.addEventListener('done', () => {
    setStatus('done', 'Finished');
    source.close();
    source = null;
    toggleRunning(false);
  });
  source.addEventListener('error', (e) => {
    if (e.data) {
      try { els.formError.textContent = JSON.parse(e.data).error || ''; } catch {}
    }
  });
}

async function stopTraffic() {
  els.stopBtn.disabled = true;
  setStatus('stopped', 'Stopping\u2026');
  try { await fetch('/api/stop', { method: 'POST' }); } catch {}
}

async function loadProxies() {
  try {
    const res = await fetch('/api/proxies');
    const data = await res.json();
    if (data.proxies && data.proxies.length > 0) {
      els.proxyList.value = data.proxies.join('\n');
      els.stProxies.textContent = fmtNum(data.count);
    } else {
      els.proxyList.placeholder = 'No proxies found. Add them manually.';
    }
  } catch {}
}

const testResult = $('testResult');
const testBtn = $('testProxiesBtn');

async function testProxies() {
  const proxyText = els.proxyList.value.trim();
  const proxies = proxyText
    ? proxyText.split('\n').map((l) => l.trim()).filter((l) => /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+$/.test(l))
    : [];
  if (proxies.length === 0) { testResult.textContent = 'No proxies to test.'; return; }
  testBtn.disabled = true;
  testResult.textContent = 'Testing ' + proxies.length + ' proxies...';
  try {
    const res = await fetch('/api/test-proxies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proxies, timeout: 5000 }),
    });
    const data = await res.json();
    if (data.aliveList) {
      testResult.textContent = data.alive + '/' + data.total + ' alive';
      if (data.aliveList.length > 0) els.proxyList.value = data.aliveList.join('\n');
      if (data.aliveList.length < proxies.length && window.confirm && data.aliveList.length > 0) {
        testResult.textContent += ' — keeping only alive proxies';
      }
    }
  } catch { testResult.textContent = 'Test failed.'; }
  testBtn.disabled = false;
}

els.startBtn.addEventListener('click', startTraffic);
els.stopBtn.addEventListener('click', stopTraffic);
testBtn.addEventListener('click', testProxies);
els.url.addEventListener('keydown', (e) => { if (e.key === 'Enter') startTraffic(); });

loadProxies();
