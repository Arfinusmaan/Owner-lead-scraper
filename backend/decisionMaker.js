import axios from 'axios';
import * as cheerio from 'cheerio';
import { getRandomUA } from './utils.js';

// =========================
// CONFIG
// =========================
const OWNER_KEYWORDS = [
  'owner', 'founder', 'ceo', 'director',
  'president', 'principal', 'manager', 'co-founder'
];

const TEAM_PATHS = [
  '/',          // homepage — fastest win
  '/about',     // most common
  '/about-us',  // second most common
];

const NAME_REGEX =
  /([A-Z][a-z]+(?:\s[A-Z][a-z]+){0,2})(?=\s*(CEO|Owner|Founder|Director))/i;

// =========================
// MAIN FUNCTION (FAST)
// =========================
export async function extractDecisionMaker(websiteUrl) {
  if (!websiteUrl || !websiteUrl.startsWith('http')) return '';

  const base = normalizeDomain(websiteUrl);

  const urls = TEAM_PATHS.map(path => buildUrl(base, path)).filter(Boolean);

  try {
    // ✅ PARALLEL + TIME LIMIT
    const results = await Promise.race([
      Promise.allSettled(
        urls.map(url => fetchAndParse(url))
      ),
      timeout(4000) // 🔥 HARD LIMIT (VERY IMPORTANT)
    ]);

    if (!Array.isArray(results)) return '';

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        console.log(`👤 Found owner: ${r.value}`);
        return r.value;
      }
    }

  } catch (err) {
    // silent — don't crash the worker pool
  }

  return '';
}

// =========================
// HELPERS
// =========================

function normalizeDomain(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}`;
  } catch {
    return url;
  }
}

function buildUrl(base, path) {
  try {
    return new URL(path, base).toString();
  } catch {
    return null;
  }
}

async function fetchAndParse(url) {
  try {
    const res = await axios.get(url, {
      timeout: 3000,
      headers: {
        'User-Agent': getRandomUA(),
        'Accept': 'text/html,*/*;q=0.9',
      },
      maxRedirects: 2,
    });

    return parseOwnerFromHtml(res.data);

  } catch {
    return '';
  }
}

function parseOwnerFromHtml(html) {
  const $ = cheerio.load(html);

  $('script, style, nav, footer').remove();

  let found = '';

  $('h1,h2,h3,h4,.title,.name,[class*="team"],[class*="owner"]').each((i, el) => {
    if (found) return;

    const text = $(el).text().trim();

    if (!text) return;

    const lower = text.toLowerCase();

    if (OWNER_KEYWORDS.some(k => lower.includes(k))) {
      const match =
        text.match(NAME_REGEX) ||
        text.match(/([A-Z][a-z]+\s[A-Z][a-z]+)/);

      if (match) {
        found = match[1];
      }
    }
  });

  return found;
}

// =========================
// TIMEOUT HELPER
// =========================
function timeout(ms) {
  return new Promise(resolve => {
    setTimeout(() => resolve(null), ms);
  });
}