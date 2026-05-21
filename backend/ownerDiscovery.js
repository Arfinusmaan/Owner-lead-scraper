/**
 * ownerDiscovery.js
 * 
 * Takes a business name and state/province, queries OpenCorporates,
 * and extracts the true, legally registered Owner/Principal name.
 * 
 * Works for both US and Canada.
 */

import axios from 'axios';
import { resolveJurisdiction } from './sosScrapers/universal.js';

const OC_BASE = 'https://api.opencorporates.com/v0.4';
const SLEEP = ms => new Promise(r => setTimeout(r, ms));

// Simple cache to avoid redundant API calls for exact same company names
const cache = new Map();

/**
 * discoverOwner(businessName, state)
 * @returns {Promise<string>} The owner's name, or empty string if not found.
 */
export async function discoverOwner(businessName, state, log = console.log, jobId = null) {
  if (!businessName || !state) return '';

  const cacheKey = `${businessName.toLowerCase()}|${state.toLowerCase()}`;
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  try {
    const jurisdictionCode = resolveJurisdiction(state);
    if (!jurisdictionCode) {
      log(`⚠️ [Discovery] Unknown jurisdiction for state: ${state}`, jobId);
      return '';
    }

    // 1. Search for the company by name in the specific jurisdiction
    const searchParams = {
      q: businessName,
      jurisdiction_code: jurisdictionCode,
      current_status: 'Active',
      per_page: 5,
    };

    const res = await axios.get(`${OC_BASE}/companies/search`, {
      params: searchParams,
      timeout: 10000,
      headers: {
        'User-Agent': 'LeadEngine/1.0 (business lead generation tool)',
        'Accept': 'application/json',
      },
    });

    const companies = res.data?.results?.companies || [];
    if (!companies.length) {
      cache.set(cacheKey, '');
      return '';
    }

    // 2. We want the best match. OpenCorporates usually returns the exact match first.
    // Let's filter out anything that doesn't strongly resemble our businessName.
    const lowerTarget = businessName.toLowerCase().replace(/[^a-z0-9]/g, ' ').trim();
    const targetWords = lowerTarget.split(/\s+/).filter(w => w.length > 2);

    let bestMatch = null;
    for (const item of companies) {
      const co = item.company;
      if (!co || !co.name) continue;

      const coLower = co.name.toLowerCase().replace(/[^a-z0-9]/g, ' ').trim();
      
      // If exact match
      if (coLower === lowerTarget) {
        bestMatch = co;
        break;
      }

      // If at least one meaningful word matches, we'll take it if it's the first one
      if (!bestMatch) {
        const matches = targetWords.some(w => coLower.includes(w));
        if (matches) {
           bestMatch = co;
        }
      }
    }

    if (!bestMatch) {
      cache.set(cacheKey, '');
      return '';
    }

    // 3. Fetch the officers for the matched company
    await SLEEP(200); // Polite rate limit
    const ownerName = await fetchOfficers(jurisdictionCode, bestMatch.company_number);
    
    if (ownerName) {
      log(`🏛️ [Discovery] Found owner for "${businessName}": ${ownerName}`, jobId);
    }
    
    cache.set(cacheKey, ownerName);
    return ownerName;

  } catch (err) {
    if (err.response && err.response.status === 429) {
      log(`⏳ [Discovery] Rate limited by OpenCorporates.`, jobId);
    }
    return '';
  }
}

/**
 * Helper to fetch officers using OpenCorporates
 */
async function fetchOfficers(jurisdictionCode, companyNumber) {
  try {
    const res = await axios.get(
      `${OC_BASE}/companies/${jurisdictionCode}/${encodeURIComponent(companyNumber)}/officers`,
      { timeout: 8000, params: { per_page: 5 } }
    );

    const officers = res.data?.results?.officers || [];
    if (!officers.length) return '';

    // Prefer active individual officers
    const OWNER_POSITIONS = ['president', 'owner', 'ceo', 'manager', 'member', 'director', 'principal', 'organizer', 'governor'];
    const sorted = officers
      .filter(o => o.officer && !o.officer.end_date) // active only
      .sort((a, b) => {
        const posA = (a.officer.position || '').toLowerCase();
        const posB = (b.officer.position || '').toLowerCase();
        const aRank = OWNER_POSITIONS.findIndex(p => posA.includes(p));
        const bRank = OWNER_POSITIONS.findIndex(p => posB.includes(p));
        return (aRank === -1 ? 99 : aRank) - (bRank === -1 ? 99 : bRank);
      });

    return sorted[0]?.officer?.name || '';
  } catch {
    return '';
  }
}
