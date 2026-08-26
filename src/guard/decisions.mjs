/**
 * Decision ledger — every Guard gate decision with reason.
 * Append-only JSON array on disk. Zero deps.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeJsonAtomic } from "../runtime/atomic.mjs";
import { dirname } from "node:path";

/**
 * @typedef {{
 *   t: string,
 *   tool: string,
 *   decision: string,
 *   reason: string,
 *   effect: Record<string, unknown>|null,
 *   sessionId: string|null,
 *   requestId: string|null,
 *   rule?: string|null,
 * }} DecisionRecord
 */

/**
 * @param {string} path
 * @returns {DecisionRecord[]}
 */
function readAll(path) {
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(raw) ? raw : Array.isArray(raw?.decisions) ? raw.decisions : [];
  } catch {
    return [];
  }
}

/**
 * @param {{ path: string }} args
 */
export function createDecisionLedger({ path } = /** @type {any} */ ({})) {
  if (!path || typeof path !== "string") {
    throw new Error("createDecisionLedger requires { path }");
  }

  /** @type {DecisionRecord[]} */
  let records = readAll(path);

  /**
   * @param {{
   *   tool?: string,
   *   decision?: string,
   *   reason?: string,
   *   effect?: Record<string, unknown>|null,
   *   sessionId?: string|null,
   *   requestId?: string|null,
   *   rule?: string|null,
   *   t?: string,
   * }} entry
   */
  function append(entry = {}) {
    /** @type {DecisionRecord} */
    const rec = {
      t: entry.t || new Date().toISOString(),
      tool: String(entry.tool ?? ""),
      decision: String(entry.decision ?? "").toUpperCase(),
      reason: String(entry.reason ?? ""),
      effect: entry.effect && typeof entry.effect === "object" ? stripRaw(entry.effect) : null,
      sessionId: entry.sessionId ?? null,
      requestId: entry.requestId ?? null,
      rule: entry.rule ?? null,
    };
    records.push(rec);
    save();
    return rec;
  }

  function list() {
    return records.slice();
  }

  function save() {
    mkdirSync(dirname(path), { recursive: true });
    writeJsonAtomic(path, records, { indent: 2, trailingNewline: true });
    return path;
  }

  function reload() {
    records = readAll(path);
    return list();
  }

  /**
   * Drop every recorded decision. The authority envelope is a separate file and
   * is not touched — clearing the audit log must not also clear the policy.
   * @returns {number} how many decisions were discarded
   */
  function clear() {
    const n = records.length;
    records = [];
    save();
    return n;
  }

  return { path, append, list, save, reload, clear };
}

/**
 * Drop bulky raw command blobs from persisted effects (keep classification fields).
 * @param {Record<string, unknown>} effect
 */
function stripRaw(effect) {
  const { raw: _raw, ...rest } = effect;
  return rest;
}
