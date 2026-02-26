import dns from 'node:dns/promises';
import { URL } from 'node:url';

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

// CIDR ranges that must never be accessed
const BLOCKED_IPV4_RANGES = [
  { prefix: '127.', mask: 8 },
  { prefix: '10.', mask: 8 },
  { prefix: '0.', mask: 8 },
  { exact: '169.254.169.254' },
];

// Check if an IPv4 address falls in a blocked range
function isBlockedIPv4(ip) {
  if (ip === '0.0.0.0' || ip === '169.254.169.254') return true;
  if (ip.startsWith('127.')) return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  // 172.16.0.0/12 — 172.16.x.x through 172.31.x.x
  if (ip.startsWith('172.')) {
    const second = parseInt(ip.split('.')[1], 10);
    if (second >= 16 && second <= 31) return true;
  }
  // 169.254.0.0/16 link-local
  if (ip.startsWith('169.254.')) return true;
  return false;
}

function isBlockedIPv6(ip) {
  const normalized = ip.toLowerCase();
  if (normalized === '::1') return true;
  // fc00::/7 — unique local (fc00 and fd00)
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  // fe80::/10 — link-local
  if (normalized.startsWith('fe80')) return true;
  // IPv4-mapped IPv6 — ::ffff:x.x.x.x
  if (normalized.startsWith('::ffff:')) {
    const v4 = normalized.slice(7);
    if (isBlockedIPv4(v4)) return true;
  }
  return false;
}

function isBlockedIP(ip) {
  return ip.includes(':') ? isBlockedIPv6(ip) : isBlockedIPv4(ip);
}

/**
 * Validate a URL for safety. Returns { url, hostname } on success, throws on failure.
 */
export async function validateUrl(input) {
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error('Invalid URL format');
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new Error(`Scheme "${parsed.protocol}" is not allowed. Only http and https are permitted.`);
  }

  const hostname = parsed.hostname;

  // Resolve DNS and check all IPs
  // Use both dns.resolve (DNS-only) and dns.lookup (/etc/hosts + DNS)
  let addresses = [];
  try {
    const [v4, v6, lookup] = await Promise.allSettled([
      dns.resolve4(hostname),
      dns.resolve6(hostname),
      dns.lookup(hostname, { all: true }),
    ]);
    if (v4.status === 'fulfilled') addresses.push(...v4.value);
    if (v6.status === 'fulfilled') addresses.push(...v6.value);
    if (lookup.status === 'fulfilled') {
      addresses.push(...lookup.value.map((r) => r.address));
    }
  } catch {
    // If DNS fails entirely, it might be an IP literal
  }

  // Deduplicate
  addresses = [...new Set(addresses)];

  // If hostname is an IP literal, check it directly
  if (addresses.length === 0) {
    const bare = hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
    if (isBlockedIP(bare)) {
      throw new Error('Access to private/internal network addresses is not allowed');
    }
  } else {
    for (const addr of addresses) {
      if (isBlockedIP(addr)) {
        throw new Error('Access to private/internal network addresses is not allowed');
      }
    }
  }

  return { url: parsed.href, hostname };
}

/**
 * Validate a redirect URL during page navigation.
 * Returns true if safe, false if blocked.
 */
export async function validateRedirect(url) {
  try {
    await validateUrl(url);
    return true;
  } catch {
    return false;
  }
}

// --- Rate Limiting ---

const requestCounts = new Map(); // ip -> { count, resetAt }
const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60_000;

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of requestCounts) {
    if (now > entry.resetAt) requestCounts.delete(ip);
  }
}, 5 * 60_000);

/**
 * Check rate limit for an IP. Returns { allowed, retryAfter }
 */
export function checkRateLimit(ip) {
  const now = Date.now();
  let entry = requestCounts.get(ip);

  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_WINDOW_MS };
    requestCounts.set(ip, entry);
  }

  entry.count++;

  if (entry.count > RATE_LIMIT) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    return { allowed: false, retryAfter };
  }

  return { allowed: true, retryAfter: 0 };
}

// --- Concurrency Semaphore ---

export class Semaphore {
  constructor(max) {
    this.max = max;
    this.current = 0;
    this.queue = [];
  }

  async acquire(timeoutMs = 10_000) {
    if (this.current < this.max) {
      this.current++;
      return;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.queue.indexOf(entry);
        if (idx !== -1) this.queue.splice(idx, 1);
        reject(new Error('Queue timeout'));
      }, timeoutMs);

      const entry = { resolve, timer };
      this.queue.push(entry);
    });
  }

  release() {
    if (this.queue.length > 0) {
      const { resolve, timer } = this.queue.shift();
      clearTimeout(timer);
      resolve();
    } else {
      this.current = Math.max(0, this.current - 1);
    }
  }
}
