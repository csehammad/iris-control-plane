/**
 * Projected monthly tool-tax savings from trimming recurring per-request tokens.
 *
 * This is an estimate — not measured spend. Callers should surface the
 * `estimated` / `label` fields wherever the figure is shown.
 *
 * @param {{
 *   perRequestTokens: number,
 *   requestsPerDay: number,
 *   days?: number,
 *   ratePerMtok: number,
 * }} args
 *   ratePerMtok — USD per 1M tokens (typically the measured cache-read / input blend)
 * @returns {{
 *   estimated: true,
 *   label: 'estimated',
 *   perRequestTokens: number,
 *   requestsPerDay: number,
 *   days: number,
 *   ratePerMtok: number,
 *   tokensPerDay: number,
 *   tokensPerMonth: number,
 *   usdPerDay: number,
 *   usdPerMonth: number,
 * }}
 */
export function monthlyProjection({
  perRequestTokens,
  requestsPerDay,
  days = 22,
  ratePerMtok,
}) {
  const tok = Number(perRequestTokens) || 0;
  const rpd = Number(requestsPerDay) || 0;
  const d = Number(days) || 0;
  const rate = Number(ratePerMtok) || 0;

  const tokensPerDay = tok * rpd;
  const tokensPerMonth = tokensPerDay * d;
  const usdPerDay = (tokensPerDay * rate) / 1e6;
  const usdPerMonth = (tokensPerMonth * rate) / 1e6;

  return {
    estimated: true,
    label: "estimated",
    perRequestTokens: tok,
    requestsPerDay: rpd,
    days: d,
    ratePerMtok: rate,
    tokensPerDay,
    tokensPerMonth,
    usdPerDay,
    usdPerMonth,
  };
}
