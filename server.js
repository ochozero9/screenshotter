import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateUrl, checkRateLimit, Semaphore } from './security.js';
import { capture, initBrowser, getBrowserStatus } from './capture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const semaphore = new Semaphore(5);
const startTime = Date.now();

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/health', (_req, res) => {
  const status = getBrowserStatus();
  res.json({
    status: 'ok',
    browser: status.alive ? 'alive' : 'dead',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    screenshotCount: status.screenshotCount,
  });
});

// Screenshot endpoint
app.post('/api/screenshot', async (req, res) => {
  // High-res full-page captures can take 60-120s — prevent Express/proxy timeouts
  req.setTimeout(180_000);
  res.setTimeout(180_000);
  const ip = req.ip || req.socket.remoteAddress;

  // Rate limit
  const { allowed, retryAfter } = checkRateLimit(ip);
  if (!allowed) {
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'Rate limit exceeded', retryAfter });
  }

  // Validate input
  const { url, viewport, deviceScaleFactor, fullPage, waitTime, darkMode, customCss, waitForSelector } = req.body;

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url is required' });
  }

  // Validate URL for SSRF
  let validated;
  try {
    validated = await validateUrl(url);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // Validate optional params
  const opts = { url: validated.url };

  if (viewport) {
    const w = parseInt(viewport.width, 10);
    const h = parseInt(viewport.height, 10);
    if (w > 0 && w <= 3840 && h > 0 && h <= 2160) {
      opts.viewport = { width: w, height: h };
    }
  }

  if (deviceScaleFactor !== undefined) {
    const s = parseInt(deviceScaleFactor, 10);
    if (s >= 1 && s <= 4) opts.deviceScaleFactor = s;
  }

  if (typeof fullPage === 'boolean') opts.fullPage = fullPage;
  if (typeof darkMode === 'boolean') opts.darkMode = darkMode;

  if (waitTime !== undefined) {
    const w = parseInt(waitTime, 10);
    if (w >= 0 && w <= 10_000) opts.waitTime = w;
  }

  if (typeof customCss === 'string' && customCss.length <= 10_000) {
    opts.customCss = customCss;
  }

  if (typeof waitForSelector === 'string' && waitForSelector.length <= 500) {
    opts.waitForSelector = waitForSelector;
  }

  // Acquire semaphore slot
  try {
    await semaphore.acquire(10_000);
  } catch {
    return res.status(503).json({ error: 'Server busy, try again shortly' });
  }

  try {
    const startMs = Date.now();
    const result = await capture(opts);
    const elapsed = Date.now() - startMs;

    const domain = validated.hostname.replace(/[^a-zA-Z0-9.-]/g, '_');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    res.set({
      'Content-Type': 'image/png',
      'Content-Disposition': `attachment; filename="screenshot-${domain}-${timestamp}.png"`,
      'X-Screenshot-Width': String(result.width),
      'X-Screenshot-Height': String(result.height),
      'X-Capture-Time-Ms': String(elapsed),
    });

    if (result.truncated) {
      res.set('X-Screenshot-Truncated', 'true');
    }
    if (result.selectorTimedOut) {
      res.set('X-Selector-Timeout', 'true');
    }

    res.send(result.buffer);
  } catch (err) {
    if (err.code === 'TOO_LARGE') {
      return res.status(413).json({
        error: 'Screenshot exceeds 50MB size limit',
        dimensions: err.dimensions,
      });
    }
    console.error('Capture error:', err.message);
    res.status(500).json({ error: `Capture failed: ${err.message}` });
  } finally {
    semaphore.release();
  }
});

// Start
async function start() {
  await initBrowser();
  app.listen(PORT, () => {
    console.log(`Screenshotter running at http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
