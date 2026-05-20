/**
 * sosScrapers/florida.js
 * Florida Division of Corporations — Sunbiz
 * https://search.sunbiz.org
 *
 * Best SOS database: open HTTP, no CAPTCHA, has real officer names.
 * Detail page reveals: Manager / Member / President = actual owner.
 */

import axios from 'axios';
import * as cheerio from 'cheerio';

const BASE    = 'https://search.sunbiz.org';
const SEARCH  = `${BASE}/Inquiry/CorporationSearch/SearchResults`;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': `${BASE}/Inquiry/CorporationSearch/ByName`,
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getDetail(path) {
  try {
    const res = await axios.get(`${BASE}${path}`, { headers: HEADERS, timeout: 12000 });
    const $   = cheerio.load(res.data);

    // Officer names live in <span class="label">Title</span> + adjacent spans
    const officers = [];
    $('span.label').each((_, el) => {
      const label = $(el).text().trim().toUpperCase();
      const ROLES = ['MANAGER', 'MEMBER', 'PRESIDENT', 'OWNER', 'DIRECTOR', 'OFFICER', 'ORGANIZER', 'PRINCIPAL'];
      if (ROLES.some(r => label.includes(r))) {
        // The name is often in the prior sibling row or next span
        const row  = $(el).closest('tr, div');
        const name = row.prev('tr, div').find('span').first().text().trim() ||
                     row.next('tr, div').find('span').first().text().trim();
        if (name && /^[A-Z]/.test(name) && name.length > 3 && name.length < 60) {
          officers.push({ name, role: label });
        }
      }
    });

    // Fallback: scan raw text for "Title MANAGER\nName JOHN SMITH" patterns
    if (!officers.length) {
      const rawText = $.text();
      const rMatch  = rawText.match(/(?:MANAGER|MEMBER|PRESIDENT|OWNER|DIRECTOR)\s+([A-Z][A-Z\s]{3,40})/);
      if (rMatch) officers.push({ name: rMatch[1].trim(), role: 'OWNER' });
    }

    // Principal address block
    let address = '';
    let city    = '';
    $('label:contains("Principal Address"), span:contains("Principal Address")').each((_, el) => {
      const block = $(el).parent().next().text().trim() ||
                    $(el).closest('tr').next('tr').text().trim();
      if (block) address = block.replace(/\s+/g, ' ').trim();
    });

    const cityMatch = address.match(/([A-Za-z\s]+),\s*FL/i);
    if (cityMatch) city = cityMatch[1].trim();

    return {
      owner_name: officers[0]?.name  || '',
      owner_role: officers[0]?.role  || '',
      address,
      city,
    };
  } catch {
    return { owner_name: '', owner_role: '', address: '', city: '' };
  }
}

export async function scrapeFlorida({
  keyword   = '',
  maxLeads  = 5000,
  onLead,
  log       = console.log,
  getJob,
  jobId,
} = {}) {
  log(`🏛️ [FL] Sunbiz scrape | keyword="${keyword}"`, jobId);
  const leads   = [];
  let   offset  = 0;
  let   hasMore = true;

  while (hasMore && leads.length < maxLeads) {
    if (getJob?.(jobId)?.stopFlag) break;

    try {
      log(`📄 [FL] Fetching offset=${offset} | ${leads.length} so far`, jobId);

      const res = await axios.get(SEARCH, {
        params: {
          SearchTerm:      keyword,
          SearchType:      'EntityName',
          SearchStatus:    'Active',
          SearchNameOrder: 'ENTITYNAME',
          listIndex:       offset,
        },
        headers: HEADERS,
        timeout: 15000,
      });

      const $ = cheerio.load(res.data);

      // Result rows: table inside #search-results
      const rows  = $('table#search-results tbody tr, .search-results tbody tr, table.results tbody tr').toArray();
      // Fallback: any table rows with entity links
      const links = $('a[href*="SearchResultDetail"]').toArray();

      if (!links.length) { hasMore = false; break; }

      for (const link of links) {
        if (leads.length >= maxLeads) break;
        if (getJob?.(jobId)?.stopFlag) break;

        const entityName = $(link).text().trim();
        const href       = $(link).attr('href') || '';

        if (!entityName || entityName.length < 2) continue;

        // Keyword filter (server sometimes returns partial matches)
        if (keyword && !entityName.toLowerCase().includes(keyword.toLowerCase())) continue;

        await sleep(250 + Math.random() * 200);
        const detail = href ? await getDetail(href) : {};

        const lead = {
          business_name: entityName,
          owner_name:    detail.owner_name || '',
          owner_role:    detail.owner_role || '',
          city:          detail.city       || '',
          state:         'Florida',
          state_code:    'FL',
          address:       detail.address    || '',
          source:        'FL SOS (Sunbiz)',
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
        log(`📋 [FL] ${entityName} | Owner: ${detail.owner_name || '—'} | ${detail.city}`, jobId);
      }

      offset += links.length;
      if (links.length < 5) hasMore = false;
      await sleep(400 + Math.random() * 300);

    } catch (err) {
      log(`❌ [FL] Error at offset ${offset}: ${err.message}`, jobId);
      hasMore = false;
    }
  }

  log(`✅ [FL] Done: ${leads.length} leads`, jobId);
  return leads;
}
