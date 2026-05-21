import { chromium } from "playwright-extra";
import stealthPlugin from "puppeteer-extra-plugin-stealth";
chromium.use(stealthPlugin());

import { log, processInBatches } from "./utils.js";
import { getSubLocations } from "./cityService.js";
import { getJob, updateJob, setPauseFlag } from "./store.js";
import { scoreLead } from "./intentScorer.js";
import { enrichOwner, whoisLookup, closeEnricherBrowser } from "./ownerEnricher.js";
import { discoverOwner } from "./ownerDiscovery.js";

// Normalize phone numbers — strip everything except digits and leading +
function cleanPhone(phone) {
  if (!phone) return '';
  return phone.replace(/[^\d+\-()\s]/g, '').trim();
}

// =========================
// WEBSITE WORKER POOL (RAM OPTIMIZED)
// =========================
class WebsiteWorkerPool {
  constructor(context, maxWorkers = 3) {
    this.context = context;
    this.maxWorkers = maxWorkers;
    this.activeWorkers = 0;
    this.queue = [];
  }

  async run(website, callback, negWords = []) {
    if (this.activeWorkers >= this.maxWorkers) {
      return new Promise((resolve) => {
        this.queue.push({ website, callback, negWords, resolve });
      });
    }

    this.activeWorkers++;
    try {
      const result = await this.extract(website, negWords);
      await callback(result); // await — callback is async (calls extractDecisionMaker)
    } finally {
      this.activeWorkers--;
      if (this.queue.length > 0) {
        const next = this.queue.shift();
        this.run(next.website, next.callback, next.negWords).then(next.resolve);
      }
    }
  }

  async extract(website, negWords = []) {
    if (!website) return { primary: "", secondary: [], owner: "" };
    
    let emails = [];
    let owner = "";
    const cleanWeb = website.replace(/\/$/, '');
    
    const isValidEmail = (email) => {
        const JUNK_DOMAINS = ['sentry.io', 'wix.com', 'google.com', 'example.com', 'domain.com', 'cloudflare.com', 'amazonaws.com'];
        const JUNK_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.mp4', '.css', '.js'];
        if (!email || email.includes('google.com')) return false;
        if (JUNK_EXTENSIONS.some(ext => email.toLowerCase().endsWith(ext))) return false;
        const domain = email.split('@')[1];
        if (!domain) return false;
        return !JUNK_DOMAINS.some(d => domain.includes(d));
    };

    const extractOwner = (text) => {
        if (owner) return;
        const roles = "CEO|Owner|Founder|Director|President|Principal|Manager|Partner";
        const res = text.match(new RegExp(`([A-Z][a-z]+(?:\\s[A-Z][a-z]+){1,2})\\s*(?:-|,|is the|:)?\\s*(${roles})`, "i")) || 
                    text.match(new RegExp(`(${roles})\\s*(?:-|,|:)?\\s*([A-Z][a-z]+(?:\\s[A-Z][a-z]+){1,2})`, "i"));
        if (res) owner = (res[1].length > res[2].length ? res[1] : res[2]).trim();
    };

    // =========================
    // RAM SAVER: Block images & media, allow fonts & CSS
    // =========================
    const blockRoute = async (page) => {
      await page.route('**/*', (route) => {
        const type = route.request().resourceType();
        // Block heavy resources but allow scripts/websockets so modern sites don't break and skip
        if (['image', 'media'].includes(type)) {
          return route.abort();
        }
        return route.continue();
      });
    };

    let pagesToVisit = [website];
    let homePage;
    try {
      homePage = await this.context.newPage();
      await blockRoute(homePage);
      await homePage.goto(website, { timeout: 8000, waitUntil: "domcontentloaded" });
      
      const html = await homePage.content();
      const text = await homePage.evaluate(() => document.body?.innerText || '');
      
      let isRejected = false;
      if (negWords && negWords.length > 0) {
          const lowerText = text.toLowerCase();
          for (const nw of negWords) {
              if (lowerText.includes(nw)) {
                  isRejected = true;
                  break;
              }
          }
      }
      if (isRejected) {
          return { primary: "", secondary: [], owner: "", isRejected: true };
      }

      extractOwner(text);
      
      const found = [...html.matchAll(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/g)]
        .map(m => m[0].toLowerCase())
        .filter(isValidEmail);
      emails.push(...found);

      // Also scan for mailto: links
      const mailtoLinks = [...html.matchAll(/mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,})/gi)]
        .map(m => m[1].toLowerCase())
        .filter(isValidEmail);
      emails.push(...mailtoLinks);

      const navLinks = await homePage.$$eval('a', as => as.map(a => ({ href: a.href || '', text: (a.innerText || '').toLowerCase() })));
      const keywords = ['contact', 'about', 'team', 'staff', 'owner', 'meet', 'appointment', 'book'];
      
      for (const link of navLinks) {
          if (keywords.some(k => link.text.includes(k)) && link.href.startsWith(cleanWeb)) {
              pagesToVisit.push(link.href);
          }
      }
    } catch (e) {
      // Silently continue — page may have failed but we move on
    } finally {
      if (homePage) await homePage.close().catch(() => {});
    }

    // Limit to top 4 pages total (home + about + contact + appointment)
    pagesToVisit = [...new Set(pagesToVisit)].slice(0, 4);
    
    for (const url of pagesToVisit.slice(1)) {
        let p;
        try {
            p = await this.context.newPage();
            await blockRoute(p);
            await p.goto(url, { timeout: 6000, waitUntil: "domcontentloaded" });
            const pText = await p.evaluate(() => document.body?.innerText || '');
            extractOwner(pText);
            const pHtml = await p.content();
            const pEmails = [
              ...[...pHtml.matchAll(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/g)].map(m => m[0].toLowerCase()),
              ...[...pHtml.matchAll(/mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,})/gi)].map(m => m[1].toLowerCase())
            ].filter(isValidEmail);
            emails.push(...pEmails);
        } catch {
          // Skip failed sub-pages
        } finally {
            if (p) await p.close().catch(() => {});
        }
    }

    emails = [...new Set(emails)];
    const priority = ["contact@", "info@", "hello@", "support@"];
    let primary = emails.find(e => priority.some(p => e.startsWith(p))) || emails[0] || "";
    
    return { primary, secondary: emails.filter(e => e !== primary), owner };
  }
}

async function checkPause(jobId) {
    while (getJob(jobId)?.pauseFlag) {
        await new Promise(r => setTimeout(r, 1000));
    }
}

export async function scrapeGoogleMaps(niche, location, filterType, negativeKeywords, jobId, mode = 'hybrid', workerCount = 3, onProgress = () => {}) {
  const job = getJob(jobId);
  if (!job) return [];

  const browser = await chromium.launch({ headless: false, args: ['--window-size=1920,1080'] });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const workerPool = new WebsiteWorkerPool(context, parseInt(workerCount));

  let subLocations = await getSubLocations(location);
  let allLeads = [];
  let workerPromises = new Set();

  const processSubLocation = async (subLoc, sIdx) => {
    updateJob(jobId, { lastProcessedIndex: sIdx });
    await checkPause(jobId);
    if (getJob(jobId)?.stopFlag) return;
    const page = await context.newPage();
    
    // =========================
    // RAM SAVER: Block images natively on Google Maps
    // =========================
    await page.route('**/*', (route) => {
        const type = route.request().resourceType();
        if (['image', 'media'].includes(type)) return route.abort();
        return route.continue();
    });
    
    try {
      const query = `${niche} in ${subLoc}`;
      log(`🚀 Searching: ${query}`, jobId);
      await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded' });
      
      // =========================
      // CAPTCHA / BOT DETECTION ENGINE AUTO-PAUSE
      // =========================
      const pageText = await page.content();
      if (pageText.includes('action="CaptchaRedirect"') || pageText.includes('Our systems have detected unusual traffic')) {
          log(`🛑 CAPTCHA DETECTED! Pausing Engine automatically...`, jobId);
          setPauseFlag(jobId, true);
          updateJob(jobId, { currentCity: "PAUSED: Captcha Action Required" });
          // Wait safely until the user manually hits 'Resume'
          while (getJob(jobId)?.pauseFlag) {
             await new Promise(r => setTimeout(r, 2000));
          }
          log(`▶️ Engine Resumed after Captcha!`, jobId);
          // Refresh the page now that it's solved
          await page.reload({ waitUntil: 'domcontentloaded' });
      }

      try {
        const rejectBtn = page.locator('button:has-text("Reject"), button:has-text("Accept")').first();
        if (await rejectBtn.count()) await rejectBtn.click();
      } catch {}

      await page.waitForSelector('div[role="feed"]', { timeout: 10000 }).catch(() => {});
      
      let noNewCount = 0;
      const processedNames = new Set();
      let lastPaneTitle = "";
      let totalFoundInCity = 0;

      while (noNewCount < 3 && !getJob(jobId)?.stopFlag) {
          const feedLocator = page.locator('div[role="feed"]');
          if (await feedLocator.count() === 0) break; // Check if the feed exists before scrolling
          
          const listings = feedLocator.locator('a[href*="/place"]');
          const batchCount = await listings.count();
          let foundNewInBatch = false;

          for (let i = 0; i < batchCount; i++) {
              await checkPause(jobId);
              if (getJob(jobId)?.stopFlag) break;
              
              let name = "";
              let item;
              try {
                 item = listings.nth(i);
                 name = await item.getAttribute("aria-label");
              } catch { continue; }
              
              if (!name || processedNames.has(name)) continue;

              const lowerName = name.toLowerCase();
              const lowerNiche = niche.toLowerCase();
              
              // Process Negative Keywords
              const negWords = (negativeKeywords || '')
                  .toLowerCase()
                  .split(',')
                  .map(w => w.trim())
                  .filter(w => w.length > 0);

              let hasNegative = false;
              for (const nw of negWords) {
                  if (lowerName.includes(nw)) {
                      hasNegative = true;
                      break;
                  }
              }

              if (hasNegative) {
                  log(`⏭️ Skipping ${name} (Negative keyword match in name)`, jobId);
                  continue;
              }
              
              // Built-in heuristics for pure Massage Spas if looking for Med Spas
              if (lowerNiche.includes('med spa') || lowerNiche.includes('medspa') || lowerNiche.includes('medical spa')) {
                  if (lowerName.includes('massage') && !lowerName.match(/med|medical|aesthetic|laser|clinic|beauty/)) {
                      log(`⏭️ Skipping ${name} (Massage spa found in Med Spa search)`, jobId);
                      continue;
                  }
              }

              processedNames.add(name);
              foundNewInBatch = true;
              totalFoundInCity++;

              try {
                  log(`👉 Clicking: ${name}`, jobId);
                  const safeName = name.replace(/"/g, '\\"');
                  let targetItem = feedLocator.locator(`a[aria-label="${safeName}"]`).first();
                  
                  if (await targetItem.count() === 0) {
                      // Fallback: If label vanished from virtual DOM, grab directly by index
                      targetItem = listings.nth(i);
                      if (await targetItem.count() === 0) {
                          log(`⚠️ Element vanished entirely, skipping.`, jobId);
                          continue;
                      }
                  }

                  try { 
                      await targetItem.scrollIntoViewIfNeeded(); 
                      await page.waitForTimeout(100); 
                  } catch {}
                  
                  try {
                     await targetItem.click({ timeout: 1500 });
                  } catch {
                     try { 
                         // Robust fallback click using JS to bypass any visible overlay
                         await targetItem.evaluate(node => node.click()); 
                     } catch {
                         try { await targetItem.focus(); await page.keyboard.press('Enter'); } catch {}
                     }
                  }

          let paneFound = false;
          for (let attempt = 0; attempt < 25; attempt++) {
              if (attempt === 5 && !paneFound) {
                  // Force a fast fallback click if Google Maps ignored it
                  try { await targetItem.focus(); await page.keyboard.press('Enter'); } catch {}
              }

              // Instant DOM evaluation: Bypasses Playwright's 30-second implicit wait which was freezing the engine
              const paneTitle = await page.evaluate(() => {
                  const h1s = Array.from(document.querySelectorAll('h1.DUwDvf, h1.fontHeadlineLarge'));
                  const visible = h1s.find(el => el.offsetParent !== null);
                  return visible ? visible.innerText.trim() : "";
              }).catch(() => "");
              
              if (paneTitle && paneTitle !== lastPaneTitle) {
                  paneFound = true;
                  lastPaneTitle = paneTitle;
                  break;
              }
              
              const paneLower = paneTitle.toLowerCase().trim();
              const nameLower = name.toLowerCase().trim();
              const nameAnchor = nameLower.split(/\s+/).slice(0, 3).join(' ');
              if (attempt > 4 && paneLower.length > 2 && (nameLower.includes(paneLower) || paneLower.includes(nameLower) || paneLower.includes(nameAnchor))) {
                  paneFound = true;
                  lastPaneTitle = paneTitle;
                  break;
              }
              
              await page.waitForTimeout(200);
          }
          if (!paneFound) {
              log(`⚠️ Timeout loading pane for ${name}, Skipping.`, jobId);
              continue;
          }
          
          // CRITICAL FIX: Give React/Angular DOM time to finish rendering new text inside the pane
          // Without this, we grab the *previous* company's website and rating before it visually updates
          await page.waitForTimeout(350); // Reduced from 1000ms for flash fast speed

          const phone = await page.locator('button[data-item-id^="phone:tel:"]').first().textContent({ timeout: 500 }).catch(() => "");
          const website = await page.locator('a[data-item-id="authority"]').first().getAttribute("href", { timeout: 500 }).catch(() => "");
          const address = await page.locator('button[data-item-id="address"]').first().textContent({ timeout: 500 }).catch(() => "");

          let rating = '';
          let reviews = '';
          let sidePaneText = '';
          try {
            const sidePane = page.locator(`div[role="main"][aria-label="${name.replace(/"/g, '\\"')}"]`).first();
            
            // Fast text extraction to check categories and description
            sidePaneText = await sidePane.textContent({ timeout: 500 }).catch(() => "");
            
            const ratingBtnLabel = await sidePane
              .locator('button[aria-label*="star"]')
              .first()
              .getAttribute('aria-label', { timeout: 500 })
              .catch(() => '');

            if (ratingBtnLabel) {
              const rMatch = ratingBtnLabel.match(/([\d.]+)\s*star/i);
              const vMatch = ratingBtnLabel.match(/([\d,]+)\s*(?:rating|review)/i);
              if (rMatch) rating  = rMatch[1];
              if (vMatch) reviews = vMatch[1].replace(/,/g, '');
            }

            if (!rating) {
              rating  = (await sidePane.locator('span.MW4etd').first().textContent({ timeout: 500 }).catch(() => '')).trim();
              reviews = (await sidePane.locator('span.UY7F9').first().textContent({ timeout: 500 }).catch(() => '')).replace(/[^\d]/g, '');
            }
          } catch { /* rating is optional, never crash */ }

          if (!phone && !website) {
              log(`⏭️ Skipping ${name} (No Phone/Web)`, jobId);
              continue;
          }

          if (website && website.includes('google.com')) {
               log(`⏭️ Skipping Google Link for ${name}`, jobId);
               continue;
          }

          // Check Negative Keywords inside the side pane (catches categories like "Massage therapist")
          if (sidePaneText) {
              const lowerPaneText = sidePaneText.toLowerCase();
              let hasNegativePane = false;
              for (const nw of negWords) {
                  // We require the negative word to be a standalone word or phrase in the text to avoid aggressive partial matching,
                  // but a simple .includes() is usually fine.
                  if (lowerPaneText.includes(nw)) {
                      hasNegativePane = true;
                      break;
                  }
              }
              
              if (hasNegativePane) {
                  log(`⏭️ Skipping ${name} (Negative keyword found in business category/details)`, jobId);
                  continue;
              }
          }

          if (filterType === 'with_website' && !website) continue;
          if (filterType === 'without_website' && website) continue;

          let lead = {
            business_name: name.trim(),
            phone: cleanPhone(phone),
            website: website || "",
            address: address?.trim() || "",
            rating: rating || "",
            reviews: reviews || "0",
            city: subLoc,
            state: location,
            primary_email: "",
            owner_name: "",
            owner_cell: "",
            owner_cell_source: "",
            owner_cell_confidence: "",
            owner_email: "",
            owner_email_source: "",
            intent: "LOW",
            score: 0
          };

          const initialScore = scoreLead(lead);
          lead.intent = initialScore.intent_tag;
          lead.score = initialScore.score;

          if (lead.website) {
            const workerTask = async (data) => {
              if (data.isRejected) {
                 log(`🚫 Purging ${name} (Negative keyword on website)`, jobId);
                 updateJob(jobId, { enrichLead: { business_name: lead.business_name, isRejected: true } });
                 return;
              }

              // Owner name from website text extraction (fallback)
              let ownerFromSite = data.owner || '';
              
              // Run OpenCorporates Owner Discovery!
              const trueOwner = await discoverOwner(lead.business_name, lead.state, log, jobId);
              if (trueOwner) {
                 ownerFromSite = trueOwner; // Override with the highly accurate government name
              }

              // Build partial enriched lead to pass into enrichOwner
              const partialLead = {
                ...lead,
                owner_name:    ownerFromSite,
                primary_email: data.primary || '',
              };

              // Run WHOIS + TPS/FPS enrichment
              const ownerData = await enrichOwner(partialLead, {
                log,
                jobId,
              }).catch(() => ({}));

              const enriched = {
                ...lead,
                primary_email:          ownerData.owner_email            || data.primary || lead.primary_email,
                owner_name:             ownerFromSite                    || lead.owner_name,
                owner_cell:             ownerData.owner_cell             || '',
                owner_cell_source:      ownerData.owner_cell_source      || '',
                owner_cell_confidence:  ownerData.owner_cell_confidence  || '',
                owner_email:            ownerData.owner_email            || '',
                owner_email_source:     ownerData.owner_email_source     || '',
              };

              const scoreResult = scoreLead(enriched);
              enriched.intent = scoreResult.intent_tag;
              enriched.score  = scoreResult.score;

              if (enriched.primary_email) log(`📧 Email: ${enriched.primary_email} — ${name}`, jobId);
              if (enriched.owner_name)    log(`👤 Owner: ${enriched.owner_name}`, jobId);
              if (enriched.owner_cell)    log(`📞 Cell: ${enriched.owner_cell}`, jobId);

              updateJob(jobId, { enrichLead: enriched });
            };

            if (mode === 'normal') {
              await workerPool.run(lead.website, workerTask, negWords);
            } else {
              const p = workerPool.run(lead.website, workerTask, negWords);
              workerPromises.add(p);
              p.finally(() => workerPromises.delete(p));
            }
          } else {
            // No website — still try WHOIS on any domain-like phone/name patterns
            // and skip TPS (no owner name yet at this point)
          }

          allLeads.push(lead);
          updateJob(jobId, { leads: [lead] });
          
          // End of finding details
          const progress = Math.min(99, Math.floor(((sIdx * 100 + totalFoundInCity) / (subLocations.length * 100)) * 100));
          onProgress({ progress, city: subLoc });

        } catch (err) { log(`❌ Error: ${err.message}`, jobId); }
      }
      
      // Scroll to load the next batch
      if (getJob(jobId)?.stopFlag) break;
      if (foundNewInBatch) noNewCount = 0;
      else noNewCount++;
      
      const feedLocatorNode = page.locator('div[role="feed"]');
      if (await feedLocatorNode.count() > 0) {
          const beforeScrollCount = await listings.count();
          await feedLocatorNode.evaluate(el => el.scrollTop = el.scrollHeight).catch(() => {});
          
          // Flash Fast Dynamic Wait instead of rigid 2000ms
          let waited = 0;
          while (waited < 4000) { // Max 4s wait for slow connections
             await page.waitForTimeout(300);
             waited += 300;
             const afterCount = await listings.count();
             if (afterCount > beforeScrollCount) break; // Found new items quickly!
          }
      } else {
          await page.waitForTimeout(1000);
      }
    }
    } catch(err) {
      log(`❌ Sub-location ${subLoc} error: ${err.message}`, jobId);
    } finally {
      await page.close();
    }
  };

  if (mode === 'parallel') {
      // Memory Optimization: Hard cap Maps page concurrency to 2 on 8GB RAM systems.
      // Background web workers can still use `workerCount`.
      const concurrency = Math.max(1, Math.min(parseInt(workerCount), 2));
      let currentIdx = job.lastProcessedIndex || 0;
      const tasks = Array.from({ length: concurrency }, async () => {
          while (currentIdx < subLocations.length && !getJob(jobId)?.stopFlag) {
              const idx = currentIdx++;
              await processSubLocation(subLocations[idx], idx);
          }
      });
      await Promise.all(tasks);
  } else {
      const startIdx = job.lastProcessedIndex || 0;
      for (let sIdx = startIdx; sIdx < subLocations.length; sIdx++) {
         if (getJob(jobId)?.stopFlag) break;
         await processSubLocation(subLocations[sIdx], sIdx);
      }
  }

  if (workerPromises.size > 0) {
      log(`⏳ Waiting for ${workerPromises.size} background email enrichment tasks to finish...`, jobId);
      await Promise.allSettled(Array.from(workerPromises));
  }

  log(`✅ Scan Finished. Total: ${allLeads.length}`, jobId);
  onProgress(100);
  await browser.close();
  await closeEnricherBrowser().catch(() => {});
  return allLeads;
}

// =========================
// CSV ENRICHMENT ENGINE
// =========================
export async function enrichCSVList(leads, jobId, workerCount = 3, negativeKeywords = '', onProgress = () => {}) {
  const job = getJob(jobId);
  if (!job) return [];
  
  log(`🚀 Starting Email Enrichment for ${leads.length} leads...`, jobId);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const workerPool = new WebsiteWorkerPool(context, parseInt(workerCount));
  
  const negWords = (negativeKeywords || '')
      .toLowerCase()
      .split(',')
      .map(w => w.trim())
      .filter(w => w.length > 0);

  let completed = 0;
  
  const batchSize = 100;
  
  await processInBatches(leads, batchSize, async (lead) => {
     if (!lead.website || getJob(jobId)?.stopFlag) {
        completed++;
        return;
     }

     return workerPool.run(lead.website, async (data) => {
        if (getJob(jobId)?.stopFlag) return;

        if (data.isRejected) {
           log(`🚫 Purging ${lead.business_name} (Negative keyword on website)`, jobId);
           updateJob(jobId, { enrichLead: { business_name: lead.business_name, isRejected: true } });
           completed++;
           return;
        }

        let ownerFromSite = data.owner || '';
        const trueOwner = await discoverOwner(lead.business_name, lead.state, log, jobId);
        if (trueOwner) {
           ownerFromSite = trueOwner;
        }

        const partialLead  = { ...lead, owner_name: ownerFromSite, primary_email: data.primary || '' };

        const ownerData = await enrichOwner(partialLead, { log, jobId }).catch(() => ({}));

        const enriched = {
           ...lead,
           primary_email:      ownerData.owner_email        || data.primary || lead.primary_email,
           owner_name:         ownerFromSite                || lead.owner_name,
           owner_cell:         ownerData.owner_cell         || '',
           owner_cell_source:  ownerData.owner_cell_source  || '',
           owner_email:        ownerData.owner_email        || '',
           owner_email_source: ownerData.owner_email_source || '',
        };

        const scoreResult = scoreLead(enriched);
        enriched.intent = scoreResult.intent_tag;
        enriched.score  = scoreResult.score;

        if (enriched.primary_email) log(`📧 ${lead.business_name}: ${enriched.primary_email}`, jobId);
        if (enriched.owner_name)    log(`👤 Owner: ${enriched.owner_name}`, jobId);
        if (enriched.owner_cell)    log(`📞 Cell: ${enriched.owner_cell}`, jobId);

        updateJob(jobId, { enrichLead: enriched });
        completed++;
        onProgress({ progress: Math.floor((completed / leads.length) * 100), city: 'Enriching Leads' });
     }, negWords);
  });
  
  log(`✅ Enrichment Complete. Processed: ${completed}`, jobId);
  
  if (!getJob(jobId)?.stopFlag) {
    onProgress(100);
  }
  
  await browser.close();
  return leads;
}
