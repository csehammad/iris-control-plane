/**
 * Export history / action ledger records to JSON or CSV. Zero deps.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

function ensureParent(path) {
  mkdirSync(dirname(path), { recursive: true });
}

/** Flatten one level of nested objects for CSV columns (billing.*, etc.). */
function flattenRecord(rec, prefix = "") {
  const out = {};
  if (rec == null || typeof rec !== "object") return out;
  for (const [k, v] of Object.entries(rec)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v != null && typeof v === "object" && !Array.isArray(v)) {
      Object.assign(out, flattenRecord(v, key));
    } else if (Array.isArray(v)) {
      out[key] = JSON.stringify(v);
    } else {
      out[key] = v;
    }
  }
  return out;
}

function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * @param {Array<object>} records
 * @param {string} path
 */
export function exportJson(records, path) {
  if (typeof path !== "string" || !path) throw new Error("exportJson requires a path");
  const rows = Array.isArray(records) ? records : [];
  ensureParent(path);
  writeFileSync(
    path,
    JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        count: rows.length,
        records: rows,
      },
      null,
      2
    ) + "\n"
  );
  return { path, count: rows.length, format: "json" };
}

/**
 * @param {Array<object>} records
 * @param {string} path
 */
export function exportCsv(records, path) {
  if (typeof path !== "string" || !path) throw new Error("exportCsv requires a path");
  const rows = Array.isArray(records) ? records : [];
  const flat = rows.map((r) => flattenRecord(r));
  const cols = [];
  const seen = new Set();
  for (const f of flat) {
    for (const k of Object.keys(f)) {
      if (!seen.has(k)) {
        seen.add(k);
        cols.push(k);
      }
    }
  }
  const lines = [cols.join(",")];
  for (const f of flat) {
    lines.push(cols.map((c) => csvEscape(f[c])).join(","));
  }
  ensureParent(path);
  writeFileSync(path, lines.join("\n") + (lines.length ? "\n" : ""));
  return { path, count: rows.length, format: "csv", columns: cols };
}
