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
  for (const key of ["estSys", "estTools", "estMsg", "sys", "tools", "msg", "total"]) {
    if (typeof out[key] === "number") out[key] = Math.round(out[key] * scale);
  }
  if (out.est && typeof out.est === "object") {
    out.est = applyCalibration(out.est, scale);
  }
  if (Array.isArray(out.rows)) {
    out.rows = out.rows.map((r) =>
      r && typeof r === "object" && typeof r.tokens === "number"
        ? { ...r, tokens: Math.round(r.tokens * scale) }
        : r
    );
  }
  out.calUsed = scale;
  return out;
}
