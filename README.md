# Screenshotter

Local screenshot server powered by Playwright. Paste a URL, get a full-page high-res PNG.

## Features

- Full-page capture with automatic scrolling for lazy-loaded content
- Configurable viewport, DPI (1x–4x), and dark mode
- Custom CSS injection (hide cookie banners, ads, sticky headers)
- Wait-for-selector support
- SSRF protection with DNS validation
- Rate limiting (5 req/min per IP) and concurrency control (max 5 simultaneous)

## Setup

```bash
npm install
npx playwright install chromium
npm start
```

Open [http://localhost:3000](http://localhost:3000).

## API

### `POST /api/screenshot`

```json
{
  "url": "https://example.com",
  "viewport": { "width": 1440, "height": 900 },
  "deviceScaleFactor": 2,
  "fullPage": true,
  "darkMode": false,
  "waitTime": 1000,
  "waitForSelector": ".main-content",
  "customCss": "header { display: none; }"
}
```

Returns a PNG image. Response headers include `X-Screenshot-Width`, `X-Screenshot-Height`, and `X-Capture-Time-Ms`.

### `GET /health`

Returns server status, browser state, and screenshot count.

## Limits

| Constraint | Value |
|---|---|
| Max page height | 15,000px |
| Max output size | 50 MB |
| Max viewport | 3840 x 2160 |
| Max DPI | 4x |
| Rate limit | 5 req/min per IP |
| Concurrent captures | 5 |
| Capture timeout | 30s |
