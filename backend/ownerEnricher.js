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

// ─── Cross-Reference Scoring ─────────────────────────────────────────────────
// Scores a TPS result card text against known business details.
// The higher the score, the more confident we are this is the right person.

function scoreCard(cardText, address, website) {
  let score = 0;
  const text = cardText.toLowerCase();

  // ── 1. Street Address Match (strongest signal) ──
  // Extract just the street number + first word of street from the Maps address
  // e.g. "1234 Main St, Austin TX" → check if "1234 main" appears in card text
  if (address) {
    const addrLower = address.toLowerCase().replace(/,.*$/, '').trim(); // drop city/state part
    const streetParts = addrLower.split(/\s+/).slice(0, 3); // first 3 words of street
    const matched = streetParts.filter(p => p.length > 2 && text.includes(p)).length;
    if (matched >= 2) score += 50; // High confidence: both number & street name match
    else if (matched >= 1) score += 20;
  }

  // ── 2. Email Domain Match (strong signal) ──
  // e.g. website = "https://apexplumbing.com" → look for "@apexplumbing.com" in card
  if (website) {
    try {
      const domain = website
        .replace(/^https?:\/\//i, '')
        .replace(/^www\./i, '')
        .split('/')[0]
        .toLowerCase()
        .trim();
      if (domain && domain.length > 4 && text.includes(domain)) {
        score += 60; // Best possible signal: their email matches the company domain
      }
    } catch {}
  }

  return score;
}

// ─── TruePeopleSearch (Cross-Reference Engine) ────────────────────────────────

async function truePeopleSearch(ownerName, city, state, address = '', website = '') {
  const parts = ownerName.trim().split(/\s+/);
  if (parts.length < 2) return null;

  const ctx = await getContext();
  const page = await ctx.newPage();

  try {
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

    // ── Pull ALL result cards, not just the first ──
    const cards = page.locator('.card-summary');
    const cardCount = await cards.count().catch(() => 0);
    if (cardCount === 0) return null;

    let bestScore  = -1;
    let bestPhone  = '';
    let firstPhone = ''; // fallback if no card scores high

    for (let i = 0; i < Math.min(cardCount, 8); i++) { // check up to 8 results
      const card = cards.nth(i);

      // Get full text of this card
      const cardText = await card.innerText().catch(() => '');

      // Get phones from tel: links inside this card (most reliable source)
      const telHrefs = await card.locator('a[href^="tel:"]').evaluateAll(links =>
        links.map(l => l.getAttribute('href') || '')
      ).catch(() => []);

      const phones = [];
      for (const href of telHrefs) {
        const num = href.replace('tel:', '').trim();
        if (!isTollFree(num)) {
          const f = formatPhone(num);
          if (f && !phones.includes(f)) phones.push(f);
        }
      }

      // Fallback: extract phones from card text
      if (phones.length === 0) {
        phones.push(...extractPhonesFromText(cardText));
      }

      if (phones.length === 0) continue; // no phone on this card, skip

      // Save the very first phone as the fallback
      if (firstPhone === '') firstPhone = phones[0];

      // Score this card with the Cross-Reference Engine
      const cardScore = scoreCard(cardText, address, website);

      if (cardScore > bestScore) {
        bestScore = cardScore;
        bestPhone = phones[0];
      }

      // 60+ means we found an email domain match — that's 100% confidence. Stop searching.
      if (bestScore >= 60) break;
    }

    // If we found a confident cross-reference match, use it.
    // If no card scored above 0, fall back to first phone (original behavior).
    const finalPhone = bestScore > 0 ? bestPhone : firstPhone;
    if (!finalPhone) return null;

    return {
      cell:       finalPhone,
      source:     'TruePeopleSearch',
      confidence: bestScore >= 60 ? 'HIGH' : bestScore >= 20 ? 'MEDIUM' : 'LOW',
    };

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

    const phones = extractPhonesFromText(bodyText.slice(0, 3000));
    return phones.length ? { cell: phones[0], source: 'FastPeopleSearch', confidence: 'LOW' } : null;

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
 * enrichOwner({ owner_name, city, state, address, phone, website, primary_email }, { log, jobId })
 * Returns: { owner_cell, owner_cell_source, owner_cell_confidence, owner_email, owner_email_source }
 */
export async function enrichOwner(lead, options = {}) {
  const { log = () => {}, jobId } = options;

  const result = {
    owner_cell:            '',
    owner_cell_source:     '',
    owner_cell_confidence: '',
    owner_email:           lead.primary_email || '',
    owner_email_source:    lead.primary_email ? 'Website' : '',
  };

  const { owner_name, city, state, website, address } = lead;

  // ── Cell Phone: TPS (with Cross-Reference) → FPS fallback ──
  if (owner_name && owner_name.trim().split(/\s+/).length >= 2) {
    await sleep(500 + Math.random() * 500);
    log(`🔍 Cell lookup: ${owner_name} | ${city}, ${state}`, jobId);

    // Pass address + website so the Cross-Reference Engine can score the results
    let hit = await truePeopleSearch(owner_name, city, state, address || '', website || '');

    if (!hit) {
      await sleep(400 + Math.random() * 300);
      hit = await fastPeopleSearch(owner_name, city, state);
    }

    if (hit) {
      const confidence = hit.confidence || 'LOW';

      if (confidence === 'LOW') {
        // ❌ Can't confirm this is the right person — discard the number entirely
        log(`🚫 Discarding LOW confidence cell for ${owner_name} — could be wrong person`, jobId);
      } else {
        // ✅ HIGH or MEDIUM — we cross-referenced address/email domain, save it
        result.owner_cell            = hit.cell;
        result.owner_cell_source     = hit.source;
        result.owner_cell_confidence = confidence;
        log(`📞 Cell: ${hit.cell} via ${hit.source} [Confidence: ${confidence}]`, jobId);
      }
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

