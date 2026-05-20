/**
 * sosScrapers/tennessee.js
 * Tennessee Secretary of State — TNBear
 * https://tnbear.tn.gov/ECommerce/FilingSearch.aspx
 *
 * ASP.NET ViewState form — requires Playwright.
 * Returns: Entity Name, Registered Agent (proxy for owner), Address, City.
 */

import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
chromium.use(stealthPlugin());

const TN_URL = 'https://tnbear.tn.gov/ECommerce/FilingSearch.aspx';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function parseDetailPage(context, href) {
  const page = await context.newPage();
  try {
    await page.route('**/*', (r) => {
      if (['image','media','font','stylesheet'].includes(r.request().resourceType())) return r.abort();
      return r.continue();
    });
    const url = href.startsWith('http') ? href : `https://tnbear.tn.gov${href}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 });
    await sleep(400);

    const text = await page.evaluate(() => document.body?.innerText || '');

    // Registered Agent = most reliable proxy for owner on small LLCs
    const agentMatch = text.match(/Registered\s+Agent\s*[:\n]+\s*([A-Z][a-zA-Z\s]{2,40})/);
    const agent = agentMatch ? agentMatch[1].replace(/\s+/g, ' ').trim() : '';

    // Principal address
    const addrMatch = text.match(/Principal\s+(?:Office\s+)?Address\s*[:\n]+\s*([^\n]+(?:\n[^\n]+){0,2})/i);
    let address = addrMatch ? addrMatch[1].replace(/\n/g, ', ').replace(/\s+/g, ' ').trim() : '';

    // City — TN addresses usually: 123 Main St, Nashville, TN 37201
    const cityMatch = address.match(/,\s*([A-Za-z\s]+),\s*TN/i);
    const city = cityMatch ? cityMatch[1].trim() : '';

    return { owner_name: agent, city, address };
  } catch {
    return { owner_name: '', city: '', address: '' };
  } finally {
    await page.close().catch(() => {});
  }
}

export async function scrapeTennessee({
  keyword  = '',
  maxLeads = 5000,
  onLead,
  log      = console.log,
  getJob,
  jobId,
} = {}) {
  log(`🏛️ [TN] TNBear scrape | keyword="${keyword}"`, jobId);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page    = await context.newPage();
  const leads   = [];

  await page.route('**/*', (r) => {
    if (['image','media','font','stylesheet'].includes(r.request().resourceType())) return r.abort();
    return r.continue();
  });

  try {
    await page.goto(TN_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(800);

    // Fill keyword / business name field
    const nameInput = page.locator('#MainContent_txtEntityName, input[name$="txtEntityName"]').first();
    if (await nameInput.count()) {
      await nameInput.fill(keyword || '');
    }

    // Status = Active
    const statusSel = page.locator('#MainContent_cboStatus, select[name$="cboStatus"]').first();
    if (await statusSel.count()) {
      await statusSel.selectOption('Active').catch(() => {});
    }

    // Click Search
    const searchBtn = page.locator('#MainContent_btnSearch, input[type="submit"][value*="Search"]').first();
    await searchBtn.click();
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
    await sleep(600);

    let pageNum = 1;
    let hasMore = true;

    while (hasMore && leads.length < maxLeads) {
      if (getJob?.(jobId)?.stopFlag) break;

      log(`📄 [TN] Page ${pageNum} | ${leads.length} leads`, jobId);

      // Extract result rows — TN SOS uses a GridView
      const rowData = await page.$$eval(
        'table[id*="grdSearch"] tr, table[id*="Grid"] tr, table.results tr',
        rows => rows.slice(1).map(tr => {
          const cells = Array.from(tr.querySelectorAll('td')).map(td => td.innerText?.trim() || '');
          const link  = tr.querySelector('a')?.getAttribute('href') || '';
          return { cells, link };
        }).filter(r => r.cells.length > 0 && r.cells[0])
      );

      if (!rowData.length) { hasMore = false; break; }

      for (const { cells, link } of rowData) {
        if (leads.length >= maxLeads || getJob?.(jobId)?.stopFlag) break;

        const entityName = cells[0] || '';
        const status     = cells[2] || cells[1] || '';

        if (!entityName || entityName.toLowerCase().includes('entity name')) continue;
        if (status && !status.toLowerCase().includes('active')) continue;
        if (keyword && !entityName.toLowerCase().includes(keyword.toLowerCase())) continue;

        let detail = { owner_name: '', city: '', address: '' };
        if (link) {
          await sleep(300 + Math.random() * 200);
          detail = await parseDetailPage(context, link);
        }

        const lead = {
          business_name: entityName,
          owner_name:    detail.owner_name,
          owner_role:    'Registered Agent',
          city:          detail.city    || cells[3] || '',
          state:         'Tennessee',
          state_code:    'TN',
          address:       detail.address || '',
          source:        'TN SOS (TNBear)',
          phone:         '',
          website:       '',
          primary_email: '',
          owner_cell:    '',
          rating:        '',
          reviews:       '',
          intent:        'LOW',
          score:         0,
        };

        leads.push(lead);
        onLead?.(lead);
        log(`📋 [TN] ${entityName} | Agent: ${detail.owner_name || '—'} | ${detail.city}`, jobId);
      }

      // Pagination — look for a "Next" link or page number
      const nextBtn = page.locator('a:has-text("Next"), input[value*="Next"]').first();
      if (await nextBtn.count() > 0) {
        await nextBtn.click();
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 });
        pageNum++;
        await sleep(500);
      } else {
        hasMore = false;
      }
    }

  } catch (err) {
    log(`❌ [TN] Fatal: ${err.message}`, jobId);
  } finally {
    await browser.close().catch(() => {});
  }

  log(`✅ [TN] Done: ${leads.length} leads`, jobId);
  return leads;
}
