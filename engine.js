'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:109.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36 Edg/118.0.2088.76',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.230 Mobile Safari/537.36',
];

const REFERERS = [
  'https://www.google.com/',
  'https://www.bing.com/',
  'https://search.yahoo.com/',
  'https://duckduckgo.com/',
  'https://www.facebook.com/',
  'https://twitter.com/',
  'https://www.instagram.com/',
  'https://www.reddit.com/',
  'https://www.linkedin.com/',
  '',
];

function randItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function loadProxyList(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const proxies = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    const addr = parts[parts.length - 1];
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+$/.test(addr)) {
      proxies.push(addr);
    }
  }
  return proxies;
}

function clampInt(v, min, max, fallback) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

class TrafficGenerator extends EventEmitter {
  constructor(config) {
    super();
    this.proxyFile = config.proxyFile
      ? path.resolve(config.proxyFile)
      : path.join(__dirname, 'IP.txt');

    this.proxies = [];
    try {
      this.proxies = loadProxyList(this.proxyFile);
    } catch (e) {
      this.proxies = config.proxies || [];
    }

    if (config.proxies && config.proxies.length > 0) {
      this.proxies = config.proxies;
    }

    this.cfg = {
      url: String(config.url || '').trim(),
      concurrency: clampInt(config.concurrency, 1, 10000, 10),
      durationSec: clampInt(config.durationSec, 0, 86400, 0),
      maxRequests: clampInt(config.maxRequests, 0, 10000000, 0),
      timeoutMs: clampInt(config.timeoutMs, 1000, 300000, 15000),
      tickMs: clampInt(config.tickMs, 100, 5000, 500),
      rotateProxyEveryRequest: config.rotateProxyEveryRequest !== false,
    };

    if (!this.cfg.url) throw new Error('Target URL is required.');
    try {
      new URL(this.cfg.url);
    } catch {
      throw new Error(`Invalid URL: ${this.cfg.url}`);
    }

    this.stopped = false;
    this.started = false;
    this.startedCount = 0;
    this.inFlight = 0;
    this.completed = 0;
    this.ok = 0;
    this.failed = 0;
    this.bytes = 0;
    this.statusCounts = Object.create(null);
    this.errorCounts = Object.create(null);
    this.startTime = 0;
    this.lastTickTime = 0;
    this.lastTickCompleted = 0;
    this.proxyIndex = 0;
  }

  start() {
    if (this.started) throw new Error('Already started.');
    if (this.proxies.length === 0) throw new Error('No proxies available. Add at least one proxy.');

    this.started = true;
    this.startTime = Date.now();
    this.lastTickTime = this.startTime;

    if (this.cfg.durationSec > 0) {
      this.durationTimer = setTimeout(() => this.stop(), this.cfg.durationSec * 1000);
    }
    this.ticker = setInterval(() => this._emitTick(false), this.cfg.tickMs);

    const workers = [];
    for (let i = 0; i < this.cfg.concurrency; i++) workers.push(this._worker());

    this._finalPromise = Promise.all(workers).then(() => this._finish());
    return this._finalPromise;
  }

  stop() {
    this.stopped = true;
  }

  _reserveSlot() {
    if (this.stopped) return false;
    if (this.cfg.maxRequests > 0 && this.startedCount >= this.cfg.maxRequests) return false;
    this.startedCount++;
    return true;
  }

  async _worker() {
    while (this._reserveSlot()) {
      await this._doRequest();
    }
  }

  _pickProxy() {
    if (this.proxies.length === 0) return null;
    if (this.cfg.rotateProxyEveryRequest) {
      this.proxyIndex = (this.proxyIndex + 1) % this.proxies.length;
      return this.proxies[this.proxyIndex];
    }
    return this.proxies[0];
  }

  _doRequest() {
    return new Promise((resolve) => {
      const proxyAddr = this._pickProxy();
      if (!proxyAddr) {
        this._tallyError('NOPROXY');
        return resolve();
      }

      const targetUrl = this.cfg.url;
      let parsed;
      try {
        parsed = new URL(targetUrl);
      } catch {
        this._tallyError('EBADURL');
        return resolve();
      }

      const [proxyHost, proxyPort] = proxyAddr.split(':');
      const isHttps = parsed.protocol === 'https:';

      const acceptLangs = ['en-US,en;q=0.9', 'en-GB,en;q=0.8', 'de-DE,de;q=0.9', 'fr-FR,fr;q=0.9', 'es-ES,es;q=0.9', 'it-IT,it;q=0.9', 'nl-NL,nl;q=0.9', 'pl-PL,pl;q=0.9', 'pt-PT,pt;q=0.9'];

      const headers = {
        'User-Agent': randItem(USER_AGENTS),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': randItem(acceptLangs),
        'Accept-Encoding': 'gzip, deflate',
        'Referer': randItem(REFERERS),
        'DNT': Math.random() > 0.5 ? '1' : '0',
        'Connection': 'close',
        'Upgrade-Insecure-Requests': '1',
        'Cache-Control': Math.random() > 0.5 ? 'no-cache' : 'max-age=0',
      };

      this.inFlight++;
      let settled = false;
      const startNs = process.hrtime.bigint();

      const finish = (fn) => {
        if (settled) return;
        settled = true;
        this.inFlight--;
        fn();
        resolve();
      };

      if (isHttps) {
        this._doHttpsViaProxy(proxyHost, parseInt(proxyPort), parsed, headers, startNs, finish);
      } else {
        this._doHttpViaProxy(proxyHost, parseInt(proxyPort), parsed, headers, startNs, finish);
      }
    });
  }

  _doHttpViaProxy(proxyHost, proxyPort, parsed, headers, startNs, finish) {
    const options = {
      hostname: proxyHost,
      port: proxyPort,
      method: 'GET',
      path: parsed.href,
      headers,
      timeout: this.cfg.timeoutMs,
    };

    const req = http.request(options, (res) => {
      let received = 0;
      res.on('data', (chunk) => { received += chunk.length; });
      res.on('end', () => {
        finish(() => {
          this.bytes += received;
          this.completed++;
          const code = res.statusCode;
          this.statusCounts[code] = (this.statusCounts[code] || 0) + 1;
          if (code >= 200 && code < 400) this.ok++;
          else this.failed++;
        });
      });
      res.on('error', () => finish(() => this._tallyError('ERESPONSE')));
    });

    req.on('error', (err) => finish(() => this._tallyError(err.code || 'EREQUEST')));
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
      finish(() => this._tallyError('ETIMEDOUT'));
    });
    req.end();
  }

  _doHttpsViaProxy(proxyHost, proxyPort, parsed, headers, startNs, finish) {
    const connectReq = http.request({
      hostname: proxyHost,
      port: proxyPort,
      method: 'CONNECT',
      path: `${parsed.hostname}:${parsed.port || 443}`,
      timeout: this.cfg.timeoutMs,
    });

    connectReq.on('connect', (res, socket) => {
      connectReq.destroy();

      const req = https.request({
        socket,
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers,
        timeout: this.cfg.timeoutMs,
        rejectUnauthorized: false,
      });

      let received = 0;
      req.on('response', (res) => {
        res.on('data', (chunk) => { received += chunk.length; });
        res.on('end', () => {
          finish(() => {
            this.bytes += received;
            this.completed++;
            const code = res.statusCode;
            this.statusCounts[code] = (this.statusCounts[code] || 0) + 1;
            if (code >= 200 && code < 400) this.ok++;
            else this.failed++;
          });
        });
        res.on('error', () => finish(() => this._tallyError('ERESPONSE')));
      });

      req.on('error', (err) => finish(() => this._tallyError(err.code || 'EREQUEST')));
      req.on('timeout', () => {
        req.destroy(new Error('timeout'));
        finish(() => this._tallyError('ETIMEDOUT'));
      });
      req.end();
    });

    connectReq.on('error', (err) => finish(() => this._tallyError(err.code || 'ECONNECT')));
    connectReq.on('timeout', () => {
      connectReq.destroy(new Error('timeout'));
      finish(() => this._tallyError('ETIMEDOUT'));
    });
    connectReq.end();
  }

  _tallyError(code) {
    this.completed++;
    this.failed++;
    this.errorCounts[code] = (this.errorCounts[code] || 0) + 1;
  }

  _snapshot(done) {
    const now = Date.now();
    const elapsedMs = now - this.startTime;
    const intervalMs = Math.max(1, now - this.lastTickTime);
    const intervalCompleted = this.completed - this.lastTickCompleted;
    const rps = (intervalCompleted / intervalMs) * 1000;
    const avgRps = elapsedMs > 0 ? (this.completed / elapsedMs) * 1000 : 0;

    let progress = null;
    if (this.cfg.maxRequests > 0) {
      progress = Math.min(1, this.completed / this.cfg.maxRequests);
    } else if (this.cfg.durationSec > 0) {
      progress = Math.min(1, elapsedMs / (this.cfg.durationSec * 1000));
    }

    return {
      done: !!done,
      elapsedMs,
      sent: this.startedCount,
      completed: this.completed,
      inFlight: this.inFlight,
      ok: this.ok,
      failed: this.failed,
      bytes: this.bytes,
      rps,
      avgRps,
      progress,
      proxyCount: this.proxies.length,
      proxyActive: this.proxies[this.proxyIndex] || '',
      statusCounts: Object.assign({}, this.statusCounts),
      errorCounts: Object.assign({}, this.errorCounts),
    };
  }

  _emitTick(done) {
    const snap = this._snapshot(done);
    this.lastTickTime = Date.now();
    this.lastTickCompleted = this.completed;
    this.emit('tick', snap);
  }

  summary() {
    return this._snapshot(true);
  }

  _finish() {
    if (this.durationTimer) clearTimeout(this.durationTimer);
    if (this.ticker) clearInterval(this.ticker);
    this.stopped = true;
    this._emitTick(true);
    const result = this.summary();
    this.emit('done', result);
    return result;
  }
}

function testProxy(addr, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const [host, port] = addr.split(':');
    const start = Date.now();
    const req = http.request({
      hostname: host,
      port: parseInt(port),
      method: 'CONNECT',
      path: 'httpbin.org:80',
      host: 'httpbin.org:80',
      timeout: timeoutMs,
    });
    req.on('connect', () => {
      req.destroy();
      resolve({ addr, alive: true, ms: Date.now() - start });
    });
    req.on('error', () => {
      req.destroy();
      resolve({ addr, alive: false, ms: Date.now() - start });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ addr, alive: false, ms: Date.now() - start });
    });
    req.end();
  });
}

module.exports = { TrafficGenerator, loadProxyList, testProxy };
