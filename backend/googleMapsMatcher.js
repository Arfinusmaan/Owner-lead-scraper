/**
 * googleMapsMatcher.js
 * 
 * Dedicated lightweight Google Maps matcher.
 * Input:  company name + city (from SOS data)
 * Output: phone + website + rating + reviews
 * 
 * Designed to run in parallel batches after SOS pull.
 * Does NOT do full city sweeps — only targeted name lookups.
 */

import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
chromium.use(stealthPlugin());

// ─────────────────────────────────────────────
// Single match: company name + city → contact info
// ─────────────────────────────────────────────

/**
 * matchBusiness(page, companyName, city, state)
 * 
 * Uses an already-open Playwright page (for speed — share browser context).
 * Returns { phone, website, rating, reviews, address, matched: bool }
 */
export async function matchBusiness(page, companyName, city, state) {
  const query = `${companyName} ${city} ${state}`.trim();

  try {
    await page.goto(
      `https://www.google.com/maps/search/${encodeURIComponent(query)}`,
      { waitUntil: 'domcontentloaded', timeout: 15000 }
    );

    // Block images to save RAM
    await page.route('**/*', (route) => {
      if (['image', 'media'].includes(route.request().resourceType())) return route.abort();
      return route.continue();
    }).catch(() => {});

    // Wait for feed or direct panel
    await page.waitForSelector('div[role="feed"], div[role="main"]', { timeout: 8000 }).catch(() => {});

    // If a single result came up, Google auto-opens the panel
    const directTitle = await page.evaluate(() => {
      const h1s = Array.from(document.querySelectorAll('h1.DUwDvf, h1.fontHeadlineLarge'));
      const visible = h1s.find(el => el.offsetParent !== null);
      return visible ? visible.innerText.trim() : '';
    }).catch(() => '');

    if (directTitle) {
      // Direct panel opened — extract immediately
      return await extractPanelData(page, directTitle);
    }

    // Multiple results — click the first one
    const firstResult = page.locator('div[role="feed"] a[href*="/place"]').first();
    if (await firstResult.count() === 0) return { matched: false };

    const firstName = await firstResult.getAttribute('aria-label').catch(() => '');
    
    // Fuzzy match: the first result should contain at least part of our company name
    const compLower    = companyName.toLowerCase().replace(/[^a-z0-9]/g, ' ').trim();
    const resultLower  = firstName.toLowerCase().replace(/[^a-z0-9]/g, ' ').trim();
    const compWords    = compLower.split(/\s+/).filter(w => w.length > 3);
    const matchedWords = compWords.filter(w => resultLower.includes(w));

    // Require at least 50% of meaningful words to match
    if (compWords.length > 0 && matchedWords.length / compWords.length < 0.4) {
      return { matched: false };
    }

    await firstResult.click({ timeout: 3000 }).catch(async () => {
      await firstResult.evaluate(n => n.click()).catch(() => {});
    });

    // Wait for panel
    await page.waitForTimeout(600);

    const panelTitle = await page.evaluate(() => {
      const h1s = Array.from(document.querySelectorAll('h1.DUwDvf, h1.fontHeadlineLarge'));
      const visible = h1s.find(el => el.offsetParent !== null);
      return visible ? visible.innerText.trim() : '';
    }).catch(() => '');

    if (!panelTitle) return { matched: false };

    return await extractPanelData(page, panelTitle);

  } catch {
    return { matched: false };
  }
}

async function extractPanelData(page, panelTitle) {
  await page.waitForTimeout(300);

  const phone   = await page.locator('button[data-item-id^="phone:tel:"]').first().textContent({ timeout: 800 }).catch(() => '');
  const website = await page.locator('a[data-item-id="authority"]').first().getAttribute('href', { timeout: 800 }).catch(() => '');
  const address = await page.locator('button[data-item-id="address"]').first().textContent({ timeout: 800 }).catch(() => '');

  let rating  = '';
  let reviews = '';

  try {
    const ratingLabel = await page
      .locator('button[aria-label*="star"]')
      .first()
      .getAttribute('aria-label', { timeout: 800 });

    if (ratingLabel) {
      const rMatch = ratingLabel.match(/([\d.]+)\s*star/i);
      const vMatch = ratingLabel.match(/([\d,]+)\s*(?:rating|review)/i);
      if (rMatch) rating  = rMatch[1];
      if (vMatch) reviews = vMatch[1].replace(/,/g, '');
    }

    if (!rating) {
      rating  = (await page.locator('span.MW4etd').first().textContent({ timeout: 500 }).catch(() => '')).trim();
      reviews = (await page.locator('span.UY7F9').first().textContent({ timeout: 500 }).catch(() => '')).replace(/\D/g, '');
    }
  } catch {}

  // Skip if website is a Google link (profile not real)
  if (website && website.includes('google.com')) {
    return {
      matched: true,
      matched_name: panelTitle,
      phone: phone?.trim() || '',
      website: '',
      address: address?.trim() || '',
      rating,
      reviews,
    };
  }

  return {
    matched: true,
    matched_name: panelTitle,
    phone: phone?.trim() || '',
    website: website?.trim() || '',
    address: address?.trim() || '',
    rating,
    reviews,
  };
}

// ─────────────────────────────────────────────
// Batch matcher: runs many companies in parallel
// using a pool of Playwright pages
// ─────────────────────────────────────────────

export async function batchMatchBusinesses(leads, { concurrency = 3, jobId, getJob, updateJob, log } = {}) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--window-size=1280,800', '--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });

  let completed = 0;
  const total = leads.length;
  const results = new Array(total).fill(null);

  // Worker pool
  const semaphore = Array.from({ length: concurrency }, (_, i) => i);
  
  const processLead = async (lead, idx) => {
    const page = await context.newPage();
    try {
      const result = await matchBusiness(page, lead.business_name || lead.company_name, lead.city, lead.state);
      results[idx] = { ...lead, ...result };
      
      if (result.matched) {
        log && log(`✅ Maps Match: ${lead.business_name || lead.company_name} → ${result.phone || 'no phone'}`, jobId);
      } else {
        log && log(`⚠️ No Maps match for: ${lead.business_name || lead.company_name}`, jobId);
      }
    } catch {
      results[idx] = lead;
    } finally {
      await page.close().catch(() => {});
      completed++;
      if (updateJob && jobId) {
        const progress = Math.floor((completed / total) * 100);
        updateJob(jobId, { progress, currentCity: `Maps matching: ${completed}/${total}` });
      }
    }
  };

  // Run with concurrency limit
  const queue = leads.map((lead, idx) => ({ lead, idx }));
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length > 0) {
      if (getJob && jobId && getJob(jobId)?.stopFlag) break;
      const item = queue.shift();
      if (!item) break;
      await processLead(item.lead, item.idx);
    }
  });

  await Promise.all(workers);
  await browser.close().catch(() => {});

  return results.filter(Boolean);
}
