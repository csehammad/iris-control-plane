/**
 * Payload-free spend ledger (history-index.json).
 */

import { readFileSync, readdirSync } from "node:fs";
import { writeJsonAtomic } from "../runtime/atomic.mjs";
import { join } from "node:path";
import { extractUsage } from "./usage.mjs";
import { estimateRequest } from "../context/analyzer.mjs";

const HISTORY_MAX_RECORDS = 20000;

export const logBasename = (f) => f.replace(/\.(req\.json|res\.txt|meta\.json)$/, "");

export function historyRecord({ uid, id, time, url, body, usage, status, ms }) {
  const e = estimateRequest(body);
  return {
    uid,
    id,
    time,
    model: body?.model ?? null,
    billing: {
      speed: body?.speed ?? null,
      inferenceGeo: usage?.inferenceGeo ?? body?.inference_geo ?? null,
      batch: String(url).includes("/batches"),
    },
    in: usage?.input ?? 0,
    cr: usage?.cacheRead ?? 0,
    cw: usage?.cacheCreate ?? 0,
    cw5: usage?.cw5m ?? 0,
    cw1: usage?.cw1h ?? 0,
    out: usage?.output ?? 0,
    think: usage?.thinking ?? 0,
    serverTools: usage?.serverTools ?? null,
    estSys: e.estSys,
    estTools: e.estTools,
    estMsg: e.estMsg,
    msgCount: e.msgCount,
    toolCount: e.toolCount,
    status: status ?? null,
    ms: ms ?? null,
  };
}

export function createHistoryLedger({ path, logDir, max = HISTORY_MAX_RECORDS }) {
  let historyIndex = [];
  const historyUids = new Set();
  const historyState = { building: false, built: null, scanned: 0, legacy: 0 };

  function addHistory(rec) {
    if (!rec || historyUids.has(rec.uid)) return false;
    historyUids.add(rec.uid);
    historyIndex.push(rec);
    if (historyIndex.length > max) {
      const drop = historyIndex.splice(0, historyIndex.length - max);
      for (const d of drop) historyUids.delete(d.uid);
    }
    return true;
  }

  function load() {
    try {
      const j = JSON.parse(readFileSync(path, "utf8"));
      if (Array.isArray(j?.records)) {
        for (const r of j.records) addHistory(r);
        historyState.built = j.builtAt ?? null;
      }
    } catch {
      /* no index yet */
    }
  }

  /**
   * Fold in anything another writer has added since this process last read.
   *
   * Two Iris instances can legitimately serve one project — the port logic
   * re-points settings but does not stop a second instance from starting — and
   * each holds the whole ledger in memory. A blind whole-file write therefore
   * loses every call the other instance recorded, with no error and nothing on
   * screen to show it.
   *
   * Rows are immutable and keyed by uid, so the union is well defined and this
   * needs no lock. Re-sorting afterwards keeps the FIFO cap meaningful: without
   * it, merged rows land at the end regardless of age and eviction would start
   * discarding recent calls.
   *
   * @returns {number} rows adopted from the other writer
   */
  function mergeFromDisk() {
    let j;
    try {
      j = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // FALLBACK-GUARD: INTENTIONAL — no file yet, or mid-write by a pre-atomic
      // Iris. Either way this process's own records are still the best available.
      return 0;
    }
    if (!Array.isArray(j?.records)) return 0;

    let adopted = 0;
    for (const r of j.records) {
      if (r && !historyUids.has(r.uid) && addHistory(r)) adopted++;
    }
    if (adopted) {
      historyIndex.sort((a, b) => String(a.time || "").localeCompare(String(b.time || "")));
      if (historyIndex.length > max) {
        const drop = historyIndex.splice(0, historyIndex.length - max);
        for (const d of drop) historyUids.delete(d.uid);
      }
    }
    return adopted;
  }

  function save() {
    try {
      /* Merge, then write atomically. The merge stops a co-resident instance's
         calls being dropped; the atomic write stops a fleet reader seeing a
         fragment and scoring this whole project as zero. */
      mergeFromDisk();
      writeJsonAtomic(path, { builtAt: new Date().toISOString(), records: historyIndex });
    } catch (e) {
      console.error("  ! could not persist history index:", e.message);
    }
  }

  /**
   * Drop every indexed call and persist the empty index.
   * Returns how many records were discarded.
   */
  function clear() {
    const n = historyIndex.length;
    historyIndex.length = 0;
    historyUids.clear();
    historyState.built = null;
    historyState.building = false;
    save();
    return n;
  }

  async function build() {
    if (historyState.building) return;
    historyState.building = true;
    const t0 = Date.now();
    let added = 0,
      legacy = 0;
    try {
      const files = readdirSync(logDir);
      const have = new Set(files);
      const reqs = files.filter((f) => f.endsWith(".req.json")).sort();
      for (let i = 0; i < reqs.length; i++) {
        const uid = logBasename(reqs[i]);
        if (historyUids.has(uid)) continue;
        if (i % 25 === 0) await new Promise((r) => setImmediate(r));

        if (have.has(uid + ".meta.json")) {
          try {
            if (addHistory(JSON.parse(readFileSync(join(logDir, uid + ".meta.json"), "utf8")))) added++;
            continue;
          } catch {
            /* fall through */
          }
        }
        if (!have.has(uid + ".res.txt")) continue;

        try {
          const log = JSON.parse(readFileSync(join(logDir, reqs[i]), "utf8"));
          if (log.method !== "POST") continue;
          const url = String(log.url ?? "");
          if (!url.includes("/v1/messages") || url.includes("count_tokens")) continue;
          const body = typeof log.body === "object" && log.body != null ? log.body : null;
          const text = readFileSync(join(logDir, uid + ".res.txt"), "utf8");
          const usage = extractUsage(text);
          if (usage.inputTotal == null && usage.output == null) continue;
          if (
            addHistory(
              historyRecord({
                uid,
                id: log.id,
                time: log.time,
                url,
                body,
                usage,
                status: 200,
                ms: null,
              })
            )
          ) {
            added++;
            legacy++;
          }
        } catch {
          /* skip */
        }
      }
      historyIndex.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
      historyState.scanned = reqs.length;
      historyState.legacy = legacy;
      historyState.built = new Date().toISOString();
      if (added) save();
      console.log(
        `History index: ${historyIndex.length} calls (${added} new, ${legacy} parsed from payloads) in ${Date.now() - t0}ms`
      );
    } catch (e) {
      console.error("  ! history index build failed:", e.message);
    } finally {
      historyState.building = false;
    }
  }

  return {
    get records() {
      return historyIndex;
    },
    get state() {
      return historyState;
    },
    addHistory,
    load,
    save,
    mergeFromDisk,
    build,
    clear,
  };
}
