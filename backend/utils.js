import { getJob } from './store.js';

// =========================
// LOGGER (FIXED + FAST)
// =========================
export function log(message, jobId = null) {
  const timestamp = new Date().toISOString();
  const msg = `[${timestamp}] ${message}`;

  console.log(msg);

  // Push directly to job.logs — skip updateJob to avoid running the
  // full leads/enrichLead pipeline on every single log line
  if (jobId) {
    try {
      const job = getJob(jobId);
      if (job) {
        job.logs = job.logs || [];
        job.logs.push(msg);
        // Trim to last 200 in-place
        if (job.logs.length > 200) job.logs.splice(0, job.logs.length - 200);
      }
    } catch (err) {
      console.log('Log attach error:', err.message);
    }
  }
}

// =========================
// HUMAN-LIKE DELAY (SMART)
// =========================
export function randomDelay(min = 300, max = 1200) {
  const base = Math.random() * (max - min) + min;
  const jitter = Math.random() * 200;

  return new Promise(resolve =>
    setTimeout(resolve, Math.floor(base + jitter))
  );
}

export const humanDelay = randomDelay;

// =========================
// ADAPTIVE DELAY (ANTI-BLOCK)
// =========================
export function adaptiveDelay(iteration = 0) {
  const base = 300 + (iteration * 20);
  const variance = Math.random() * 500;

  return new Promise(resolve =>
    setTimeout(resolve, Math.floor(base + variance))
  );
}

// =========================
// TIMEOUT WRAPPER (CRITICAL)
// =========================
export function withTimeout(promise, ms = 5000) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout')), ms)
    )
  ]);
}

// =========================
// RETRY SYSTEM (CRITICAL)
// =========================
export async function retry(fn, attempts = 2, delay = 800) {
  let lastError;

  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      await randomDelay(delay, delay + 400);
    }
  }

  throw lastError;
}

// =========================
// BATCH PROCESSOR (CLEAN)
// =========================
export async function processInBatches(items, batchSize, handler) {
  const results = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);

    const res = await Promise.all(
      batch.map(item => handler(item))
    );

    results.push(...res);
  }

  return results;
}

// =========================
// USER AGENTS (EXPANDED)
// =========================
export function getRandomUA() {
  const agents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/121 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile Safari/604.1"
  ];

  return agents[Math.floor(Math.random() * agents.length)];
}

// =========================
// SAFE NAVIGATION (FIX FREEZE)
// =========================
export async function safeGoto(page, url, timeout = 15000) {
  try {
    await withTimeout(
      page.goto(url, { waitUntil: 'domcontentloaded' }),
      timeout
    );
  } catch (err) {
    throw new Error(`Failed to load ${url}`);
  }
}

// =========================
// SAFE CLICK (FIX STUCK CLICK)
// =========================
export async function safeClick(locator) {
  try {
    await retry(() => locator.click({ force: true }), 2);
  } catch (err) {
    throw new Error('Click failed');
  }
}