/**
 * Token calibration — chars/4 undercounts Claude 4.7+ tokenizers (~1.55× on Opus 5).
 * The reported input total covers the same three buckets the estimate covers, so the
 * ratio *is* the correction. Raw estimates must never be priced without this step.
 */

/**
 * @param {number} estimatedTokens  sum of estSys + estTools + estMsg (chars/4)
 * @param {number} measuredInputTotal  usage.input + cacheRead + cacheCreate
 * @returns {number|null} factor, or null when either side is missing/zero
 */
export function calibrate(estimatedTokens, measuredInputTotal) {
  const est = Number(estimatedTokens);
  const measured = Number(measuredInputTotal);
  if (!Number.isFinite(est) || !Number.isFinite(measured) || est <= 0 || measured < 0) return null;
  return measured / est;
}

/**
 * Scale a raw estimate (number or { sys, tools, msg, … } / estimateRequest shape) by factor.
 * Numbers are rounded; object fields known to be token estimates are scaled in place-safe copies.
 */
export function applyCalibration(est, factor) {
  const f = Number(factor);
  const scale = Number.isFinite(f) && f > 0 ? f : 1;
  if (est == null) return est;
  if (typeof est === "number") return Math.round(est * scale);
  if (typeof est !== "object") return est;

  const out = { ...est };
  for (const key of SCALED_NUMBERS) {
    if (typeof out[key] === "number") out[key] = Math.round(out[key] * scale);
  }
  if (out.est && typeof out.est === "object") {
    out.est = applyCalibration(out.est, scale);
  }
  /* Every list of sized things Iris renders: tool rows, context-diff parts, and
     tool_result attributions all carry a `tokens` field that is a chars/4 estimate. */
  for (const key of SCALED_ARRAYS) {
    if (!Array.isArray(out[key])) continue;
    out[key] = out[key].map((r) =>
      r && typeof r === "object" && typeof r.tokens === "number"
        ? { ...r, tokens: Math.round(r.tokens * scale) }
        : r
    );
  }
  out.calUsed = scale;
  return out;
}

const SCALED_NUMBERS = [
  "estSys", "estTools", "estMsg",
  "sys", "tools", "msg", "total",
  "deltaTokens", "totalTokens", "tokens",
];
const SCALED_ARRAYS = ["rows", "parts", "results"];

/**
 * The factor to use when a panel has no single call to calibrate against.
 *
 * Each history record carries both sides: the chars/4 estimate it was built from
 * and the input total the response reported. The median of their ratios over the
 * recent window is the session's correction — median rather than mean so one
 * oddly-shaped call (a tiny title-generation request, a failed turn) cannot drag
 * the whole panel.
 *
 * @param {Array<{estSys?:number, estTools?:number, estMsg?:number, in?:number, cr?:number, cw?:number}>} records
 * @param {{ sample?: number }} [opts]
 * @returns {number|null} null when nothing usable is on record — callers must then
 *   leave the estimate uncorrected rather than inventing a factor.
 */
export function sessionFactor(records, opts = {}) {
  const sample = opts.sample ?? 40;
  if (!Array.isArray(records) || !records.length) return null;
  const ratios = [];
  for (const r of records.slice(-sample)) {
    const est = (r?.estSys ?? 0) + (r?.estTools ?? 0) + (r?.estMsg ?? 0);
    const measured = (r?.in ?? 0) + (r?.cr ?? 0) + (r?.cw ?? 0);
    if (est > 0 && measured > 0) ratios.push(measured / est);
  }
  if (!ratios.length) return null;
  ratios.sort((a, b) => a - b);
  const mid = ratios.length >> 1;
  return ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
}
