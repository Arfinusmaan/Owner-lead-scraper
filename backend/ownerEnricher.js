/**
 * ownerEnricher.js
 * Finds owner cell phone (TruePeopleSearch → FastPeopleSearch)
 * and owner email (WHOIS RDAP) — all 100% free, no API keys.
 *
 * TPS/FPS use Playwright stealth because they have Cloudflare.
 * WHOIS uses axios (RDAP is open JSON, no auth needed).
 */

import axios from 'axios';
import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
chromium.use(stealthPlugin());

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function formatPhone(raw) {
  if (!raw) return '';
  const d = raw.replace(/\D/g, '');
  if (d.length === 10) return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
  if (d.length === 11 && d[0] === '1') return `(${d.slice(1,4)}) ${d.slice(4,7)}-${d.slice(7)}`;
  return raw.trim();
}

function isTollFree(phone) {
  const d = phone.replace(/\D/g, '');
  const area = d.length === 11 ? d.slice(1, 4) : d.slice(0, 3);
  return ['800','888','877','866','855','844','833'].includes(area);
}

function extractPhonesFromText(text) {
  const phones = [];
  const matches = text.matchAll(/\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/g);
  for (const m of matches) {
    if (!isTollFree(m[0])) {
      const f = formatPhone(m[0]);
      if (f && !phones.includes(f)) phones.push(f);
    }
  }
  return phones;
}

// ─── Shared Browser Pool ──────────────────────────────────────────────────────

let _browser = null;
let _context = null;
let _useCount = 0;

async function getContext() {
  if (!_browser || !_browser.isConnected()) {
    _browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
    });
    _context = await _browser.newContext({
      viewport: { width: 1366, height: 768 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'en-US',
    });
    _useCount = 0;
  }
  _useCount++;
  // Recycle every 80 lookups to prevent memory creep
  if (_useCount > 80) {
    await _browser.close().catch(() => {});
    _browser = null;
    return getContext();
  }
  return _context;
}

export async function closeEnricherBrowser() {
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser = null;
    _context = null;
  }
}

// ─── TruePeopleSearch ─────────────────────────────────────────────────────────

async function truePeopleSearch(ownerName, city, state) {
  const parts = ownerName.trim().split(/\s+/);
  if (parts.length < 2) return null;

  const ctx = await getContext();
  const page = await ctx.newPage();

  try {
    // Block images/fonts to speed up
    await page.route('**/*', (route) => {
      const t = route.request().resourceType();
      if (['image', 'media', 'font', 'stylesheet'].includes(t)) return route.abort();
      return route.continue();
    });

    const name = `${encodeURIComponent(parts[0])}+${encodeURIComponent(parts[parts.length - 1])}`;
    const loc  = encodeURIComponent(`${city}, ${state}`);
    const url  = `https://www.truepeoplesearch.com/results?name=${name}&citystatezip=${loc}`;

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 18000 });
    await sleep(1200 + Math.random() * 600);

    const title = await page.title().catch(() => '');
    if (title.toLowerCase().includes('denied') || title.toLowerCase().includes('cloudflare')) return null;

    // First result card
    const card = page.locator('.card-summary').first();
    if (!await card.count()) return null;

    const cardText = await card.innerText().catch(() => '');
    const phones   = extractPhonesFromText(cardText);

    // Also check tel: href links inside the card
    const telHrefs = await card.locator('a[href^="tel:"]').evaluateAll(links =>
      links.map(l => l.getAttribute('href') || '')
    ).catch(() => []);

    for (const href of telHrefs) {
      const num = href.replace('tel:', '').trim();
      if (!isTollFree(num)) {
        const f = formatPhone(num);
        if (f && !phones.includes(f)) phones.unshift(f);
      }
    }

    return phones.length ? { cell: phones[0], source: 'TruePeopleSearch' } : null;

  } catch {
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

// ─── FastPeopleSearch ─────────────────────────────────────────────────────────

async function fastPeopleSearch(ownerName, city, state) {
  const parts = ownerName.trim().split(/\s+/);
  if (parts.length < 2) return null;

  const ctx  = await getContext();
  const page = await ctx.newPage();

  try {
    await page.route('**/*', (route) => {
      const t = route.request().resourceType();
      if (['image', 'media', 'font', 'stylesheet'].includes(t)) return route.abort();
      return route.continue();
    });

    const nameSlug  = ownerName.trim().toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '-');
    const citySlug  = (city  || '').toLowerCase().replace(/\s+/g, '-');
    const stateSlug = (state || '').toLowerCase().replace(/\s+/g, '-');
    const url = `https://www.fastpeoplesearch.com/name/${nameSlug}_${citySlug}-${stateSlug}`;

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 18000 });
    await sleep(900 + Math.random() * 500);

    const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    if (bodyText.includes('No results') || bodyText.trim().length < 50) return null;

    const phones = extractPhonesFromText(bodyText.slice(0, 3000)); // Only first 3000 chars = first result
    return phones.length ? { cell: phones[0], source: 'FastPeopleSearch' } : null;

  } catch {
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

// ─── WHOIS via RDAP (no auth, open standard) ─────────────────────────────────

export async function whoisLookup(website) {
  if (!website) return null;
  try {
    const domain = website
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .split('/')[0]
      .toLowerCase()
      .trim();

    if (!domain || domain.length < 4 || !domain.includes('.')) return null;

    const rdap = await axios.get(`https://rdap.org/domain/${domain}`, {
      timeout: 8000,
      headers: { Accept: 'application/json' },
    }).catch(() => null);

    if (!rdap?.data?.entities) return null;

    for (const entity of rdap.data.entities) {
      if (!entity.vcardArray || !Array.isArray(entity.vcardArray[1])) continue;
      for (const entry of entity.vcardArray[1]) {
        if (entry[0] === 'email' && entry[3]) {
          const email = String(entry[3]).toLowerCase().trim();
          const SKIP  = ['privacy', 'protect', 'whoisguard', 'proxy', 'withheld', 'redacted', 'noreply', 'domains'];
          if (!SKIP.some(s => email.includes(s)) && email.includes('@')) {
            return { email, source: 'WHOIS' };
          }
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Main Export ──────────────────────────────────────────────────────────────

/**
 * enrichOwner({ owner_name, city, state, phone, website, primary_email }, { log, jobId })
 * Returns: { owner_cell, owner_cell_source, owner_email, owner_email_source }
 */
export async function enrichOwner(lead, options = {}) {
  const { log = () => {}, jobId } = options;

  const result = {
    owner_cell:         '',
    owner_cell_source:  '',
    owner_email:        lead.primary_email || '',
    owner_email_source: lead.primary_email ? 'Website' : '',
  };

  const { owner_name, city, state, website } = lead;

  // ── Cell Phone: TPS → FPS ──
  if (owner_name && owner_name.trim().split(/\s+/).length >= 2) {
    await sleep(500 + Math.random() * 500);
    log(`🔍 Cell lookup: ${owner_name} | ${city}, ${state}`, jobId);

    let hit = await truePeopleSearch(owner_name, city, state);

    if (!hit) {
      await sleep(400 + Math.random() * 300);
      hit = await fastPeopleSearch(owner_name, city, state);
    }

    if (hit) {
      result.owner_cell        = hit.cell;
      result.owner_cell_source = hit.source;
      log(`📞 Cell: ${hit.cell} via ${hit.source}`, jobId);
    } else {
      log(`⚠️ No cell found for ${owner_name}`, jobId);
    }
  }

  // ── Email: WHOIS (if not already found by website scrape) ──
  if (!result.owner_email && website) {
    const whois = await whoisLookup(website);
    if (whois?.email) {
      result.owner_email        = whois.email;
      result.owner_email_source = 'WHOIS';
      log(`📧 WHOIS: ${whois.email}`, jobId);
    }
  }

  return result;
}
