/**
 * sosScrapers/index.js
 * Routes all SOS scrape requests through the universal OpenCorporates scraper.
 */

export { scrapeUniversal, ALL_JURISDICTIONS, US_STATES, CA_PROVINCES, resolveJurisdiction } from './universal.js';

/**
 * scrapeByState(jurisdiction, options) — kept for backward compatibility
 */
export async function scrapeByState(jurisdiction, options = {}) {
  const { scrapeUniversal } = await import('./universal.js');
  return scrapeUniversal({ jurisdiction, ...options });
}
