# Web Traffic Generator

A web-based traffic generator that rotates proxies to simulate visitors from multiple IP addresses and locations. Useful for testing how analytics and tracking systems handle traffic from diverse geographic sources.

Built with pure Node.js — zero external dependencies.

---

## Features

- **Proxy rotation** — each request uses a different proxy from your list, making traffic appear to come from different IPs worldwide
- **Visitor fingerprint randomization** — automatic rotation of User-Agent, Referer, Accept-Language, and other headers per request to simulate real browsers
- **HTTP & HTTPS targets** — supports both protocols via HTTP proxy forwarding and CONNECT tunneling
- **Real-time dashboard** — live stats: completed requests, in-flight, success/fail, requests/sec, data received, active proxy count
- **Live charts** — throughput (req/s) and success ratio over time
- **Proxy health tester** — built-in tool to test which proxies are alive and filter out dead ones
- **Concurrent visitors** — configurable number of parallel "visitors"
- **Duration or request cap** — run for a set time or stop after N total requests
- **Custom proxy list** — paste any `ip:port` list directly in the UI

---

## Requirements

- Node.js 18+ (check with `node --version`)

## Quick Start

```bash
cd /Users/aj/Desktop/Projects/playground/WebTrafficGenerator
npm start
```

Open **http://127.0.0.1:4321** in your browser.

## How to Use

1. **Target URL** — enter the full URL (e.g. `https://example.com/page`)
2. **Proxies** — the app loads proxies from `IP.txt` automatically. Click **Test Proxies** to check which ones are alive (recommended before each run, as free proxies die quickly)
3. **Concurrent Visitors** — number of simultaneous requests (start with 10–50)
4. **Duration** — how long to run in seconds (0 = unlimited, runs until you click Stop)
5. **Max Requests** — optional cap on total requests sent
6. **Timeout** — max wait time per request in ms
7. Click **Start Traffic**

The dashboard shows live results. Click **Stop** at any time.

## Proxy Sources

The included `IP.txt` contains ~2,200 proxies aggregated from:
- [Proxifly](https://github.com/proxifly/free-proxy-list)
- [Databay](https://databay.com/free-proxy-list)

Free proxies are unreliable and die quickly. For production use, replace with a paid proxy service (any `ip:port` format works).

## Project Structure

```
WebTrafficGenerator/
├── engine.js       # Traffic engine — proxy rotation, request dispatch, stats
├── server.js       # HTTP server — API endpoints + SSE real-time streaming
├── IP.txt          # Proxy list (ip:port, one per line)
├── package.json
├── .gitignore
└── public/
    ├── index.html  # Dashboard UI
    ├── app.js      # Frontend client
    └── styles.css  # Dark theme styling
```

## How It Works

1. Each concurrent worker picks the next proxy from the list (round-robin)
2. Random User-Agent, Referer, Accept-Language, and Cache-Control headers are generated per request
3. For HTTP targets, the request is sent directly through the proxy
4. For HTTPS targets, a CONNECT tunnel is established through the proxy
5. Stats are streamed to the browser via Server-Sent Events every 500ms

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/start` | Start traffic generation |
| `POST` | `/api/stop` | Stop active run |
| `POST` | `/api/test-proxies` | Test proxy health |
| `GET` | `/api/stream?runId=` | SSE real-time stream |
| `GET` | `/api/proxies` | List loaded proxies |

## License

MIT
