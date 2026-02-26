import { chromium } from 'playwright';
import zlib from 'node:zlib';
import { validateRedirect } from './security.js';

const MAX_HEIGHT = 15_000;
const MAX_OUTPUT_SIZE = 50 * 1024 * 1024; // 50MB
const CAPTURE_TIMEOUT = 30_000;
const RESTART_INTERVAL = 100; // screenshots before restart
const RESTART_TIME = 60 * 60 * 1000; // 1 hour

let browser = null;
let screenshotCount = 0;
let launchTime = 0;

async function launchBrowser() {
  if (browser) {
    try { await browser.close(); } catch {}
  }
  browser = await chromium.launch({
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox',
    ],
  });
  screenshotCount = 0;
  launchTime = Date.now();
  console.log('Browser launched');
}

async function getBrowser() {
  const needsRestart = !browser ||
    !browser.isConnected() ||
    screenshotCount >= RESTART_INTERVAL ||
    (Date.now() - launchTime) > RESTART_TIME;

  if (needsRestart) await launchBrowser();
  return browser;
}

export async function initBrowser() {
  await launchBrowser();
}

export function getBrowserStatus() {
  return {
    alive: browser?.isConnected() ?? false,
    uptime: launchTime ? Math.floor((Date.now() - launchTime) / 1000) : 0,
    screenshotCount,
  };
}

// --- Pure Node PNG stitcher (no browser canvas, no external deps) ---

function parsePng(buf) {
  // Verify PNG signature
  if (buf[0] !== 137 || buf[1] !== 80 || buf[2] !== 78 || buf[3] !== 71) {
    throw new Error('Not a PNG');
  }

  let offset = 8;
  let ihdr = null;
  const idatChunks = [];

  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    const data = buf.subarray(offset + 8, offset + 8 + len);

    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }

    offset += 12 + len; // 4(length) + 4(type) + data + 4(crc)
  }

  return { ihdr, idatChunks };
}

function decompressRows(idatChunks) {
  const compressed = Buffer.concat(idatChunks);
  return zlib.inflateSync(compressed);
}

// CRC32 lookup table
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[n] = c;
}

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function makeChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBytes, data]);
  const crcVal = crc32(crcInput);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crcVal, 0);
  return Buffer.concat([len, typeBytes, data, crcBuf]);
}

function stitchPngs(tiles, totalPixelW, totalPixelH) {
  // Parse first tile to get PNG properties
  const first = parsePng(tiles[0]);
  const { bitDepth, colorType } = first.ihdr;

  // Decompress all tiles and collect raw row data
  const rowDataParts = [];
  for (let i = 0; i < tiles.length; i++) {
    const parsed = i === 0 ? first : parsePng(tiles[i]);
    const rows = decompressRows(parsed.idatChunks);
    rowDataParts.push(rows);
    tiles[i] = null; // Free the PNG buffer
  }

  // Concatenate raw rows — each row is: filter_byte + pixel_data
  // Tiles may have different heights (last tile), but same width & format
  // We need to trim if total rows exceed totalPixelH
  const bytesPerPixel = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : colorType === 4 ? 2 : 4;
  const rowBytes = 1 + totalPixelW * bytesPerPixel;
  let totalRows = 0;
  const validParts = [];

  for (const part of rowDataParts) {
    const partRows = part.length / rowBytes;
    const rowsNeeded = Math.min(partRows, totalPixelH - totalRows);
    if (rowsNeeded <= 0) break;
    if (rowsNeeded < partRows) {
      validParts.push(part.subarray(0, rowsNeeded * rowBytes));
    } else {
      validParts.push(part);
    }
    totalRows += rowsNeeded;
  }

  const combined = Buffer.concat(validParts);
  const compressed = zlib.deflateSync(combined, { level: 6 });

  // Build output PNG
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(totalPixelW, 0);
  ihdrData.writeUInt32BE(totalPixelH, 4);
  ihdrData[8] = bitDepth;
  ihdrData[9] = colorType;
  // compression=0, filter=0, interlace=0

  const chunks = [signature, makeChunk('IHDR', ihdrData)];

  // Split IDAT into 64KB chunks (PNG best practice)
  const IDAT_SIZE = 65536;
  for (let i = 0; i < compressed.length; i += IDAT_SIZE) {
    chunks.push(makeChunk('IDAT', compressed.subarray(i, Math.min(i + IDAT_SIZE, compressed.length))));
  }

  chunks.push(makeChunk('IEND', Buffer.alloc(0)));

  return Buffer.concat(chunks);
}

// --- Capture ---

export async function capture(opts) {
  const {
    url,
    viewport = { width: 1440, height: 900 },
    deviceScaleFactor = 2,
    fullPage = true,
    waitTime = 1000,
    darkMode = false,
    customCss = '',
    waitForSelector = '',
  } = opts;

  const dpr = Math.min(4, Math.max(1, deviceScaleFactor));
  const b = await getBrowser();
  const context = await b.newContext({
    viewport,
    deviceScaleFactor: dpr,
    colorScheme: darkMode ? 'dark' : 'light',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  try {
    // Remove webdriver flag
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    // Intercept redirects for SSRF protection
    page.on('request', async (request) => {
      if (request.isNavigationRequest() && request.redirectedFrom()) {
        const targetUrl = request.url();
        const safe = await validateRedirect(targetUrl);
        if (!safe) {
          try { await request.abort('blockedbyclient'); } catch {}
        }
      }
    });

    // Navigate with timeout
    await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: CAPTURE_TIMEOUT,
    });

    // Wait for fonts
    await page.waitForFunction(() => document.fonts.ready.then(() => true), {
      timeout: 5000,
    }).catch(() => {});

    // Wait for custom selector
    let selectorTimedOut = false;
    if (waitForSelector) {
      try {
        await page.waitForSelector(waitForSelector, { timeout: 10_000 });
      } catch {
        selectorTimedOut = true;
      }
    }

    // Scroll incrementally to trigger lazy-loaded images/content
    if (fullPage) {
      const scrollHeight = await page.evaluate(() => document.body.scrollHeight);
      const vpHeight = viewport.height;
      const steps = Math.ceil(scrollHeight / vpHeight);
      for (let i = 1; i <= steps; i++) {
        await page.evaluate((y) => window.scrollTo(0, y), i * vpHeight);
        await page.waitForTimeout(300);
      }
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(500);
    }

    // Inject custom CSS
    if (customCss) {
      await page.addStyleTag({ content: customCss });
    }

    // Extra wait
    if (waitTime > 0) {
      await page.waitForTimeout(Math.min(waitTime, 10_000));
    }

    // Wait for images triggered by scrolling
    await page.evaluate(() => {
      const images = Array.from(document.images).filter((img) => !img.complete);
      if (images.length === 0) return;
      return Promise.race([
        Promise.all(images.map((img) => new Promise((r) => { img.onload = img.onerror = r; }))),
        new Promise((r) => setTimeout(r, 5000)),
      ]);
    }).catch(() => {});

    // Measure page height
    const pageHeight = await page.evaluate(() =>
      Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)
    );
    let truncated = false;
    let captureHeight = fullPage ? pageHeight : viewport.height;

    if (fullPage && pageHeight > MAX_HEIGHT) {
      truncated = true;
      captureHeight = MAX_HEIGHT;
    }

    let buffer;

    if (fullPage && captureHeight > viewport.height) {
      // Neutralize fixed/sticky elements
      await page.evaluate(() => {
        for (const el of document.querySelectorAll('*')) {
          const pos = getComputedStyle(el).position;
          if (pos === 'fixed') {
            el.style.setProperty('position', 'absolute', 'important');
          } else if (pos === 'sticky') {
            el.style.setProperty('position', 'relative', 'important');
          }
        }
      });

      // Freeze all animations/transitions
      await page.addStyleTag({
        content: `
          *, *::before, *::after {
            animation-duration: 0s !important;
            animation-delay: 0s !important;
            animation-iteration-count: 1 !important;
            transition-duration: 0s !important;
            transition-delay: 0s !important;
            scroll-behavior: auto !important;
          }
        `,
      });
      await page.waitForTimeout(200);

      // Re-measure after de-stickying and animation freeze
      const finalHeight = await page.evaluate(() =>
        Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)
      );
      captureHeight = truncated ? Math.min(finalHeight, MAX_HEIGHT) : finalHeight;

      // Cap page height if truncated, then use Playwright's fullPage capture
      // (uses CDP captureBeyondViewport — renders all content without resizing viewport)
      if (truncated) {
        await page.addStyleTag({
          content: `html, body { max-height: ${captureHeight}px !important; overflow: hidden !important; }`,
        });
        await page.waitForTimeout(100);
      }

      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(200);

      buffer = await page.screenshot({ type: 'png', fullPage: true });
    } else {
      buffer = await page.screenshot({ type: 'png', fullPage });
    }

    if (buffer.length > MAX_OUTPUT_SIZE) {
      const err = new Error('Screenshot exceeds 50MB size limit');
      err.code = 'TOO_LARGE';
      err.dimensions = {
        width: viewport.width * dpr,
        height: captureHeight * dpr,
      };
      throw err;
    }

    screenshotCount++;

    const width = viewport.width * dpr;
    const height = captureHeight * dpr;

    return { buffer, width, height, truncated, selectorTimedOut };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}
