export function scoreLead(lead) {
  let score = 0;

  // =========================
  // SAFE PARSING
  // =========================
  const rating = parseFloat(lead.rating) || 0;
  const reviews = parseInt(lead.reviews) || 0;

  const hasWebsite = !!lead.website;
  const hasEmail = !!lead.primary_email;

  // =========================
  // CORE SCORING (OPPORTUNITY BASED)
  // =========================

  // 🔥 HIGH VALUE SIGNALS
  if (!hasEmail) score += 40;        // No email = huge opportunity
  if (!hasWebsite) score += 30;     // No site = easy sell

  // 🔥 COMPETITION LEVEL
  if (reviews < 50) score += 25;
  else if (reviews < 150) score += 15;
  else if (reviews < 300) score += 5;

  // 🔥 QUALITY LEVEL
  if (rating > 0 && rating < 4.2) score += 20;
  else if (rating < 4.6) score += 10;

  // =========================
  // BONUS SIGNALS
  // =========================

  // Low reviews + good rating = hidden gem
  if (reviews < 100 && rating >= 4.0) {
    score += 10;
  }

  // Website but no email = weak funnel
  if (hasWebsite && !hasEmail) {
    score += 10;
  }

  // =========================
  // NORMALIZATION
  // =========================
  if (score > 100) score = 100;

  // =========================
  // INTENT CLASSIFICATION
  // =========================
  let intent = 'LOW';

  if (score >= 65) intent = 'HIGH';
  else if (score >= 35) intent = 'MEDIUM';

  return {
    score,
    intent_tag: intent
  };
}