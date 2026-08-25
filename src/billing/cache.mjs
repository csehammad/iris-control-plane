/**
 * Cache write premium: what the 5m/1h write rates cost above base input.
 * Matches iris.html cacheEconomicsOf().premium.
 *
 * @param {{ cw5m?: number, cw1h?: number, cw5?: number, cw1?: number }|null|undefined} usage
 * @param {{ input?: number, in?: number, cw5m?: number, cw5?: number, cw1h?: number, cw1?: number }|null|undefined} rates
 * @returns {number}
 */
export function cacheWritePremium(usage, rates) {
  if (!usage || !rates) return 0;
  const input = rates.input ?? rates.in;
  const cw5Rate = rates.cw5m ?? rates.cw5;
  const cw1Rate = rates.cw1h ?? rates.cw1;
  if (input == null || cw5Rate == null || cw1Rate == null) return 0;
  const cw5 = usage.cw5m ?? usage.cw5 ?? 0;
  const cw1 = usage.cw1h ?? usage.cw1 ?? 0;
  return (cw5 * (cw5Rate - input) + cw1 * (cw1Rate - input)) / 1e6;
}

/**
 * Dollars avoided by reading from cache instead of paying full input price.
 * Matches iris.html cacheEconomicsOf().avoided.
 *
 * @param {{ cacheRead?: number, cr?: number }|null|undefined} usage
 * @param {{ input?: number, in?: number, cacheRead?: number, cr?: number }|null|undefined} rates
 * @returns {number}
 */
export function avoidedByCache(usage, rates) {
  if (!usage || !rates) return 0;
  const input = rates.input ?? rates.in;
  const crRate = rates.cacheRead ?? rates.cr;
  if (input == null || crRate == null) return 0;
  const cr = usage.cacheRead ?? usage.cr ?? 0;
  return (cr * (input - crRate)) / 1e6;
}
