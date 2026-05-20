import zipcodes from 'zipcodes';
import { State, City } from 'country-state-city';

// =========================
// CANADIAN FSA MAP (Forward Sortation Areas)
// Canada doesn't use zip codes — FSAs are the equivalent for Google Maps
// Format: "City, Province" → [list of FSA codes]
// =========================
const CANADIAN_FSA = {
  // Ontario
  'toronto':     ['M5V', 'M4W', 'M6H', 'M6J', 'M6K', 'M6R', 'M6S', 'M9A', 'M9B', 'M9C'],
  'ottawa':      ['K1P', 'K1R', 'K1S', 'K1Y', 'K2A', 'K2B', 'K2C', 'K2G', 'K2H'],
  'mississauga': ['L4T', 'L4V', 'L4W', 'L4X', 'L4Y', 'L4Z', 'L5A', 'L5B', 'L5C', 'L5E'],
  'brampton':    ['L6P', 'L6R', 'L6S', 'L6T', 'L6V', 'L6W', 'L6X', 'L6Y', 'L6Z'],
  'hamilton':    ['L8E', 'L8G', 'L8H', 'L8J', 'L8K', 'L8L', 'L8M', 'L8N', 'L8P', 'L8R'],
  'london':      ['N5V', 'N5W', 'N5X', 'N5Y', 'N5Z', 'N6A', 'N6B', 'N6C', 'N6E', 'N6G'],
  'windsor':     ['N8H', 'N8N', 'N8P', 'N8R', 'N8S', 'N8T', 'N8W', 'N8X', 'N8Y', 'N9A'],
  'kitchener':   ['N2A', 'N2B', 'N2C', 'N2E', 'N2G', 'N2H', 'N2K', 'N2M', 'N2N'],
  'waterloo':    ['N2J', 'N2K', 'N2L', 'N2T', 'N2V'],
  // British Columbia
  'vancouver':   ['V5K', 'V5L', 'V5M', 'V5N', 'V5P', 'V5R', 'V5S', 'V5T', 'V5V', 'V5W', 'V5X', 'V5Y', 'V5Z', 'V6A', 'V6B'],
  'surrey':      ['V3R', 'V3S', 'V3T', 'V3V', 'V3W', 'V3X', 'V3Z', 'V4A', 'V4N', 'V4P'],
  'burnaby':     ['V3J', 'V3N', 'V5A', 'V5B', 'V5C', 'V5E', 'V5G', 'V5H', 'V5J'],
  'richmond':    ['V6V', 'V6W', 'V6X', 'V6Y', 'V7A', 'V7B', 'V7C', 'V7E'],
  'kelowna':     ['V1W', 'V1X', 'V1Y', 'V1Z'],
  'victoria':    ['V8N', 'V8P', 'V8R', 'V8S', 'V8T', 'V8V', 'V8W', 'V8X', 'V8Y', 'V8Z', 'V9A'],
  'abbotsford':  ['V2S', 'V2T'],
  // Alberta
  'calgary':     ['T1Y', 'T2A', 'T2B', 'T2C', 'T2E', 'T2G', 'T2H', 'T2J', 'T2K', 'T2L', 'T2M', 'T2N', 'T2P', 'T2R', 'T2S', 'T2T', 'T2V', 'T2W', 'T2X', 'T2Y', 'T2Z', 'T3A', 'T3B', 'T3C', 'T3E', 'T3G', 'T3H', 'T3J', 'T3K', 'T3L', 'T3M', 'T3N', 'T3P', 'T3R'],
  'edmonton':    ['T5A', 'T5B', 'T5C', 'T5E', 'T5G', 'T5H', 'T5J', 'T5K', 'T5L', 'T5M', 'T5N', 'T5P', 'T5R', 'T5S', 'T5T', 'T5V', 'T5W', 'T5X', 'T5Y', 'T5Z', 'T6A', 'T6B', 'T6C', 'T6E', 'T6G', 'T6H', 'T6J', 'T6K', 'T6L', 'T6M', 'T6N', 'T6P', 'T6R', 'T6S', 'T6T', 'T6V', 'T6W', 'T6X'],
  'red deer':    ['T4N', 'T4P', 'T4R', 'T4S'],
  'lethbridge':  ['T1H', 'T1J', 'T1K'],
  // Quebec
  'montreal':    ['H1A', 'H1B', 'H1C', 'H1E', 'H1G', 'H1H', 'H1J', 'H1K', 'H1L', 'H1M', 'H1N', 'H1P', 'H1R', 'H1S', 'H1T', 'H1V', 'H1W', 'H1X', 'H1Y', 'H1Z', 'H2A', 'H2B', 'H2C', 'H2E', 'H2G', 'H2H', 'H2J', 'H2K', 'H2L', 'H2M', 'H2N', 'H2P', 'H2R', 'H2S', 'H2T', 'H2V', 'H2W', 'H2X', 'H2Y', 'H2Z', 'H3A', 'H3B', 'H3C', 'H3E', 'H3G', 'H3H', 'H3J', 'H3K', 'H3L', 'H3M', 'H3N', 'H3P', 'H3R', 'H3S', 'H3T', 'H3V', 'H3W', 'H3X', 'H3Y', 'H3Z', 'H4A', 'H4B', 'H4C', 'H4E', 'H4G', 'H4H'],
  'quebec city': ['G1A', 'G1B', 'G1C', 'G1E', 'G1G', 'G1H', 'G1J', 'G1K', 'G1L', 'G1M', 'G1N', 'G1P', 'G1R', 'G1S', 'G1T', 'G1V', 'G1W', 'G1X', 'G1Y', 'G2A', 'G2B', 'G2C', 'G2E', 'G2G', 'G2H', 'G2J', 'G2K', 'G2L', 'G2M', 'G2N'],
  'laval':       ['H7A', 'H7B', 'H7C', 'H7E', 'H7G', 'H7H', 'H7J', 'H7K', 'H7L', 'H7M', 'H7N', 'H7P', 'H7R', 'H7S', 'H7T', 'H7V', 'H7W', 'H7X', 'H7Y'],
  'longueuil':   ['J4G', 'J4H', 'J4J', 'J4K', 'J4L', 'J4M', 'J4N', 'J4P', 'J4R', 'J4S', 'J4T', 'J4V', 'J4W', 'J4X', 'J4Y'],
  // Manitoba
  'winnipeg':    ['R2C', 'R2E', 'R2G', 'R2H', 'R2J', 'R2K', 'R2L', 'R2M', 'R2N', 'R2P', 'R2R', 'R2V', 'R2W', 'R2X', 'R2Y', 'R3A', 'R3B', 'R3C', 'R3E', 'R3G', 'R3H', 'R3J', 'R3K', 'R3L', 'R3M', 'R3N', 'R3P', 'R3R', 'R3S', 'R3T', 'R3V', 'R3W', 'R3X', 'R3Y'],
  // Saskatchewan
  'saskatoon':   ['S7H', 'S7J', 'S7K', 'S7L', 'S7M', 'S7N', 'S7P', 'S7R', 'S7S', 'S7T', 'S7V', 'S7W'],
  'regina':      ['S4N', 'S4P', 'S4R', 'S4S', 'S4T', 'S4V', 'S4W', 'S4X', 'S4Y', 'S4Z'],
  // Nova Scotia
  'halifax':     ['B3A', 'B3B', 'B3G', 'B3H', 'B3J', 'B3K', 'B3L', 'B3M', 'B3N', 'B3P', 'B3R', 'B3S', 'B3T'],
  // New Brunswick
  'fredericton': ['E3A', 'E3B', 'E3C', 'E3E', 'E3G'],
  'moncton':     ['E1A', 'E1B', 'E1C', 'E1E', 'E1G', 'E1H'],
  // Newfoundland
  "st. john's":  ['A1A', 'A1B', 'A1C', 'A1E', 'A1G', 'A1H'],
};

// =========================
// GEOGRAPHIC EXPANSION
// =========================
export async function getSubLocations(locationName) {
  let subLocations = [];

  try {
    const query = locationName.trim();
    const queryLower = query.toLowerCase();

    // 1. Universal State/Province Expansion (works for US and ALL countries)
    const allStates = State.getAllStates();
    const matchedState = allStates.find(s => 
      s.name.toLowerCase() === queryLower || 
      s.isoCode.toLowerCase() === queryLower ||
      (s.countryCode + "-" + s.isoCode).toLowerCase() === queryLower
    );

    if (matchedState) {
      const cities = City.getCitiesOfState(matchedState.countryCode, matchedState.isoCode);
      subLocations = cities.map(c => `${c.name}, ${matchedState.isoCode}, ${matchedState.countryCode}`);
      subLocations = [...new Set(subLocations)];
      console.log(`🌍 Expanded "${matchedState.name}" (${matchedState.countryCode}) → ${subLocations.length} cities.`);
      return subLocations.length > 0 ? subLocations : [locationName];
    }

    // 2. City → ZIP/FSA Expansion
    if (query.includes(",")) {
      const parts = query.split(",").map(p => p.trim());
      const city = parts[0];
      const province = parts[1]; // TX, ON, BC, etc.

      // 2a. Canadian City → FSA expansion
      const cityKey = city.toLowerCase();
      if (CANADIAN_FSA[cityKey]) {
        subLocations = CANADIAN_FSA[cityKey];
        console.log(`🍁 Expanded Canadian city "${city}" → ${subLocations.length} FSA codes.`);
        return subLocations;
      }

      // 2b. US City → ZIP expansion
      if (province && (province.length === 2 || province.length === 3)) {
        const found = zipcodes.lookupByName(city, province);
        if (found && found.length > 0) {
          subLocations = [...new Set(found.map(z => z.zip).filter(Boolean))];
          if (subLocations.length > 0) {
            console.log(`🇺🇸 Expanded US city "${query}" → ${subLocations.length} ZIP codes.`);
            return subLocations;
          }
        }
      }
    }
    
    // 3. Try Canadian city without province (e.g. just "Toronto")
    const cityKey = query.toLowerCase();
    if (CANADIAN_FSA[cityKey]) {
      subLocations = CANADIAN_FSA[cityKey];
      console.log(`🍁 Expanded Canadian city "${query}" → ${subLocations.length} FSA codes.`);
      return subLocations;
    }

    console.log(`⚠️ No expansion found for "${locationName}", searching as-is.`);
    return [locationName];

  } catch (err) {
    console.log("❌ Location mapping error:", err.message);
    return [locationName];
  }
}