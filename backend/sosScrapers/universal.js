/**
 * sosScrapers/universal.js
 *
 * Universal SOS scraper using OpenCorporates API
 * Covers: All 50 US States + All Canadian Provinces
 * Free, no API key required (rate-limited ~500 calls/day on free tier)
 *
 * API docs: https://api.opencorporates.com/documentation
 */

import axios from 'axios';

const OC_BASE = 'https://api.opencorporates.com/v0.4';
const SLEEP   = ms => new Promise(r => setTimeout(r, ms));

// ─── All supported jurisdictions ─────────────────────────────────────────────

export const US_STATES = {
  'Alabama':        'us_al', 'Alaska':         'us_ak', 'Arizona':       'us_az',
  'Arkansas':       'us_ar', 'California':      'us_ca', 'Colorado':      'us_co',
  'Connecticut':    'us_ct', 'Delaware':        'us_de', 'Florida':       'us_fl',
  'Georgia':        'us_ga', 'Hawaii':          'us_hi', 'Idaho':         'us_id',
  'Illinois':       'us_il', 'Indiana':         'us_in', 'Iowa':          'us_ia',
  'Kansas':         'us_ks', 'Kentucky':        'us_ky', 'Louisiana':     'us_la',
  'Maine':          'us_me', 'Maryland':        'us_md', 'Massachusetts': 'us_ma',
  'Michigan':       'us_mi', 'Minnesota':       'us_mn', 'Mississippi':   'us_ms',
  'Missouri':       'us_mo', 'Montana':         'us_mt', 'Nebraska':      'us_ne',
  'Nevada':         'us_nv', 'New Hampshire':   'us_nh', 'New Jersey':    'us_nj',
  'New Mexico':     'us_nm', 'New York':        'us_ny', 'North Carolina':'us_nc',
  'North Dakota':   'us_nd', 'Ohio':            'us_oh', 'Oklahoma':      'us_ok',
  'Oregon':         'us_or', 'Pennsylvania':    'us_pa', 'Rhode Island':  'us_ri',
  'South Carolina': 'us_sc', 'South Dakota':    'us_sd', 'Tennessee':     'us_tn',
  'Texas':          'us_tx', 'Utah':            'us_ut', 'Vermont':       'us_vt',
  'Virginia':       'us_va', 'Washington':      'us_wa', 'West Virginia': 'us_wv',
  'Wisconsin':      'us_wi', 'Wyoming':         'us_wy',
};

export const CA_PROVINCES = {
  'Alberta':              'ca_ab', 'British Columbia':   'ca_bc',
  'Manitoba':             'ca_mb', 'New Brunswick':      'ca_nb',
  'Newfoundland':         'ca_nl', 'Nova Scotia':        'ca_ns',
  'Ontario':              'ca_on', 'Prince Edward Island':'ca_pe',
  'Quebec':               'ca_qc', 'Saskatchewan':       'ca_sk',
};

export const ALL_JURISDICTIONS = { ...US_STATES, ...CA_PROVINCES };

/**
 * Get jurisdiction code from user input.
 * Accepts: "Florida", "FL", "us_fl", "Ontario", "ON", "ca_on"
 */
export function resolveJurisdiction(input) {
  if (!input) return null;
  const trimmed = input.trim();

  // Already a code (us_fl, ca_on)
  if (/^(us|ca)_[a-z]{2,4}$/.test(trimmed.toLowerCase())) {
    return trimmed.toLowerCase();
  }

  // 2-letter abbreviation: FL → Florida → us_fl
  if (trimmed.length === 2) {
    const upper = trimmed.toUpperCase();
    // US states 2-letter
    const US_ABBR = {
      AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',
      CO:'Colorado',CT:'Connecticut',DE:'Delaware',FL:'Florida',GA:'Georgia',
      HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',
      KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',
      MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',
      NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',
      NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',
      OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',
      SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',
      VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming',
      // Canada provinces 2-letter
      AB:'Alberta',BC:'British Columbia',MB:'Manitoba',NB:'New Brunswick',
      NL:'Newfoundland',NS:'Nova Scotia',ON:'Ontario',PE:'Prince Edward Island',
      QC:'Quebec',SK:'Saskatchewan',
    };
    if (US_ABBR[upper]) {
      return ALL_JURISDICTIONS[US_ABBR[upper]] || null;
    }
  }

  // Full name lookup
  const key = Object.keys(ALL_JURISDICTIONS).find(
    k => k.toLowerCase() === trimmed.toLowerCase()
  );
  return key ? ALL_JURISDICTIONS[key] : null;
}

/**
 * Get officer/owner name for a company from OpenCorporates
 */
async function fetchOfficers(jurisdictionCode, companyNumber) {
  try {
    const res = await axios.get(
      `${OC_BASE}/companies/${jurisdictionCode}/${encodeURIComponent(companyNumber)}/officers`,
      { timeout: 8000, params: { per_page: 5 } }
    );

    const officers = res.data?.results?.officers || [];
    if (!officers.length) return '';

    // Prefer active individual officers (not corporate officers)
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

/**
 * Main universal scraper
 * @param {Object} opts
 * @param {string} opts.jurisdiction - State/Province name or code (e.g. "Florida", "FL", "us_fl")
 * @param {string} opts.keyword      - Niche keyword to search (e.g. "restoration", "plumbing")
 * @param {number} opts.maxLeads     - Max leads to pull (default 3000)
 * @param {Function} opts.onLead     - Callback per lead found
 * @param {Function} opts.log        - Logging function
 * @param {Function} opts.getJob     - Store getter
 * @param {string}  opts.jobId       - Job ID for stop checks
 */
export async function scrapeUniversal({
  jurisdiction,
  keyword     = '',
  maxLeads    = 3000,
  onLead,
  log         = console.log,
  getJob,
  jobId,
} = {}) {
  const jurisdictionCode = resolveJurisdiction(jurisdiction);
  if (!jurisdictionCode) {
    throw new Error(`Unknown state/province: "${jurisdiction}". Use a full name (e.g. "Florida") or abbreviation (e.g. "FL").`);
  }

  const stateName = Object.entries(ALL_JURISDICTIONS).find(([, v]) => v === jurisdictionCode)?.[0] || jurisdiction;
  const isCanada  = jurisdictionCode.startsWith('ca_');

  log(`🏛️ [OC] Scraping ${stateName} (${jurisdictionCode}) | keyword: "${keyword}"`, jobId);

  const leads    = [];
  let   page     = 1;
  let   hasMore  = true;
  let   totalHit = 0;

  while (hasMore && leads.length < maxLeads) {
    if (getJob?.(jobId)?.stopFlag) break;

    try {
      log(`📄 [OC] Page ${page} | ${leads.length} leads so far`, jobId);

      const params = {
        q:                  keyword || '',
        jurisdiction_code:  jurisdictionCode,
        current_status:     'Active',
        per_page:           100,
        page,
        // Order by incorporation date (newest first = more likely still running)
        order:              'incorporation_date desc',
      };

      const res = await axios.get(`${OC_BASE}/companies/search`, {
        params,
        timeout: 20000,
        headers: {
          'User-Agent': 'LeadEngine/1.0 (business lead generation tool)',
          'Accept': 'application/json',
        },
      });

      const data      = res.data?.results;
      const companies = data?.companies || [];
      totalHit        = data?.total_count || 0;

      if (!companies.length) { hasMore = false; break; }

      for (const item of companies) {
        if (leads.length >= maxLeads || getJob?.(jobId)?.stopFlag) break;

        const co = item.company;
        if (!co || !co.name) continue;

        // Keyword filter on name (OC searches broadly)
        if (keyword && !co.name.toLowerCase().includes(keyword.toLowerCase())) continue;

        // Skip non-LLC / non-active
        const companyType = (co.company_type || '').toLowerCase();
        // Allow: llc, limited liability, corporation, inc, ltd, sole prop, etc.
        // Skip: banks, insurance, holding companies with obvious flags
        const SKIP_TYPES  = ['bank', 'insurance company', 'holding'];
        if (SKIP_TYPES.some(s => companyType.includes(s))) continue;

        // Address parsing
        const addr  = co.registered_address || {};
        const city  = addr.locality || addr.city || '';
        const state = addr.region   || stateName;
        const address = [addr.street_address, city, addr.postal_code]
          .filter(Boolean).join(', ');

        // Fetch officer (owner) name — do it for every lead
        let ownerName = '';
        if (co.company_number) {
          await SLEEP(150 + Math.random() * 150); // Polite rate limiting
          ownerName = await fetchOfficers(jurisdictionCode, co.company_number);
        }

        const lead = {
          business_name:  co.name,
          company_number: co.company_number || '',
          company_type:   co.company_type   || '',
          owner_name:     ownerName,
          owner_role:     ownerName ? 'Officer' : '',
          city,
          state:          isCanada ? stateName : state || stateName,
          state_code:     jurisdictionCode,
          country:        isCanada ? 'Canada' : 'USA',
          address,
          incorporation_date: co.incorporation_date || '',
          source:         `OpenCorporates (${stateName})`,
          phone:          '',
          website:        co.home_company?.website || '',
          primary_email:  '',
          owner_cell:     '',
          owner_cell_source: '',
          owner_email:    '',
          owner_email_source: '',
          rating:         '',
          reviews:        '',
          intent:         'LOW',
          score:          0,
        };

        leads.push(lead);
        onLead?.(lead);
        log(`📋 ${co.name} | ${city}, ${state} | Owner: ${ownerName || '—'}`, jobId);
      }

      // OpenCorporates caps free tier at 20 pages (2000 results)
      if (page >= 20 || leads.length >= totalHit) {
        hasMore = false;
      } else {
        page++;
      }

      // Rate limit: 1 req/sec on free tier
      await SLEEP(1100 + Math.random() * 300);

    } catch (err) {
      if (err.response?.status === 429) {
        log(`⏳ [OC] Rate limited — waiting 30s...`, jobId);
        await SLEEP(30000);
      } else if (err.response?.status === 404) {
        log(`⚠️ [OC] No results for jurisdiction: ${jurisdictionCode}`, jobId);
        hasMore = false;
      } else {
        log(`❌ [OC] Page ${page} error: ${err.message}`, jobId);
        hasMore = false;
      }
    }
  }

  log(`✅ [OC] Done: ${leads.length} leads from ${stateName}`, jobId);
  return leads;
}
