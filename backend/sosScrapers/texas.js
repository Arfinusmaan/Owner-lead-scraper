/**
 * sosScrapers/texas.js
 * Texas Secretary of State — SOSDirect / Comptroller
 * https://mycpa.cpa.state.tx.us/coa/
 *
 * Texas Comptroller Certificate of Account Status search.
 * Open JSON API — returns taxpayer name, address, and status.
 * For owner names we also hit the SOS entity search.
 */

import axios from 'axios';
import * as cheerio from 'cheerio';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Texas Open Data search via the Comptroller's taxpayer search (free).
 * Falls back to SOS entity search scraping if comptroller returns nothing.
 */
async function searchTexasComptroller(keyword, offset = 0) {
  try {
    // Texas Comptroller has a JSON-returning search endpoint
    const res = await axios.get('https://mycpa.cpa.state.tx.us/coa/coaSearchByName', {
      params: {
        NAME: keyword,
        START_ROW: offset,
      },
      headers: { ...HEADERS, 'X-Requested-With': 'XMLHttpRequest' },
      timeout: 15000,
    });

    if (res.data && Array.isArray(res.data.results)) {
      return res.data.results.map(r => ({
        business_name: r.name || r.companyName || '',
        taxpayer_id:   r.id   || r.taxpayerNumber || '',
        city:          r.city || '',
        address:       r.address || '',
        status:        r.status || 'Active',
      }));
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Texas SOS entity search (HTML scrape fallback).
 * https://direct.sos.state.tx.us/corp_inquiry/corp_inquiry-entity.asp
 */
async function searchTxSOS(keyword) {
  try {
    const res = await axios.get('https://direct.sos.state.tx.us/corp_inquiry/corp_inquiry-entity.asp', {
      params: {
        PreviousPage: 'nameSearch',
        NameSearchType: 'EXACT_MATCH',
        EntityName: keyword,
        EntityType: 'ALL',
        EntityStatus: 'ALL',
      },
      headers: HEADERS,
      timeout: 15000,
    });

    const $ = cheerio.load(res.data);
    const rows = [];

    $('table tr').each((i, tr) => {
      if (i === 0) return; // skip header
      const cells = $(tr).find('td').toArray().map(td => $(td).text().trim());
      const link  = $(tr).find('a').first().attr('href') || '';
      if (cells[0] && cells[0].length > 2) {
        rows.push({ entityName: cells[0], status: cells[2] || '', link });
      }
    });

    return rows;
  } catch {
    return [];
  }
}

/**
 * Get officer/director names from TX SOS detail page.
 */
async function getTxSOSDetail(path) {
  try {
    const url = path.startsWith('http')
      ? path
      : `https://direct.sos.state.tx.us${path}`;

    const res = await axios.get(url, { headers: HEADERS, timeout: 12000 });
    const $   = cheerio.load(res.data);
    const txt = $.text();

    const OFFICER_ROLES = ['MANAGER', 'MEMBER', 'PRESIDENT', 'DIRECTOR', 'OFFICER', 'GOVERNOR', 'ORGANIZER'];
    let ownerName = '';
    let address   = '';
    let city      = '';

    for (const role of OFFICER_ROLES) {
      const rx = new RegExp(`${role}[\\s\\S]{0,30}?([A-Z][A-Z\\s]{3,40})`, 'i');
      const m  = txt.match(rx);
      if (m) { ownerName = m[1].replace(/\s+/g, ' ').trim(); break; }
    }

    const addrMatch = txt.match(/(?:Principal\s+Office|Address)[:\s]+([^\n]{10,80})/i);
    if (addrMatch) {
      address = addrMatch[1].replace(/\s+/g, ' ').trim();
      const cityMatch = address.match(/,\s*([A-Za-z\s]+),\s*TX/i);
      if (cityMatch) city = cityMatch[1].trim();
    }

    return { owner_name: ownerName, address, city };
  } catch {
    return { owner_name: '', address: '', city: '' };
  }
}

export async function scrapeTexas({
  keyword  = '',
  maxLeads = 5000,
  onLead,
  log      = console.log,
  getJob,
  jobId,
} = {}) {
  log(`🏛️ [TX] Texas SOS scrape | keyword="${keyword}"`, jobId);
  const leads   = [];
  let   offset  = 0;
  let   hasMore = true;

  // First try TX Comptroller (JSON, fastest)
  while (hasMore && leads.length < maxLeads) {
    if (getJob?.(jobId)?.stopFlag) break;

    log(`📄 [TX] Comptroller offset=${offset} | ${leads.length} leads`, jobId);

    const results = await searchTexasComptroller(keyword, offset);
    if (!results.length) {
      hasMore = false;
      break;
    }

    for (const r of results) {
      if (leads.length >= maxLeads) break;
      if (!r.business_name) continue;
      if (!r.status?.toLowerCase().includes('active')) continue;
      if (keyword && !r.business_name.toLowerCase().includes(keyword.toLowerCase())) continue;

      const lead = {
        business_name: r.business_name,
        owner_name:    '',
        owner_role:    '',
        city:          r.city || '',
        state:         'Texas',
        state_code:    'TX',
        address:       r.address || '',
        source:        'TX SOS (Comptroller)',
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
      log(`📋 [TX] ${r.business_name} | ${r.city}`, jobId);
    }

    offset += results.length;
    if (results.length < 10) hasMore = false;
    await sleep(400 + Math.random() * 300);
  }

  // If Comptroller returned nothing, fallback to SOS HTML scrape
  if (leads.length === 0) {
    log(`⚠️ [TX] Comptroller empty — falling back to SOS entity search`, jobId);
    const rows = await searchTxSOS(keyword);

    for (const row of rows) {
      if (leads.length >= maxLeads || getJob?.(jobId)?.stopFlag) break;
      if (!row.entityName) continue;
      if (row.status && !row.status.toLowerCase().includes('active')) continue;

      await sleep(300 + Math.random() * 200);
      const detail = row.link ? await getTxSOSDetail(row.link) : {};

      const lead = {
        business_name: row.entityName,
        owner_name:    detail.owner_name || '',
        owner_role:    'Officer',
        city:          detail.city    || '',
        state:         'Texas',
        state_code:    'TX',
        address:       detail.address || '',
        source:        'TX SOS',
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
      log(`📋 [TX] ${row.entityName} | Owner: ${detail.owner_name || '—'}`, jobId);
    }
  }

  log(`✅ [TX] Done: ${leads.length} leads`, jobId);
  return leads;
}
