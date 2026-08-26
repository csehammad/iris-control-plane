/**
 * Fleet spend — every project on this machine, read from disk.
 *
 * A per-project total answers "what did this repo cost". Nobody is billed per
 * repo. On a subscription seat one allowance covers every project *and* Claude
 * chat, so the per-project share of usage that Optimize shows understates what
 * any single repo draws from the plan. The fleet total is the honest denominator.
 *
 * There is no coordination here, and deliberately so. Three Iris instances on
 * three projects each read the same registry and the same ledger files, and each
 * arrives at the same number without a socket, a leader, or shared state. A
 * fourth project needs no announcement — it appears the moment its ledger exists.
 *
 * Two consequences of reading other processes' files, both handled rather than
 * hidden:
 *
 *   Torn reads. Ledgers are rewritten whole. They now go through
 *   writeJsonAtomic, so a reader sees the previous file or the next one and
 *   never a fragment — but a ledger written by an older Iris has no such
 *   guarantee, so an unparseable ledger is reported as an unreadable project
 *   rather than counted as zero.
 *
 *   Staleness. A running Iris flushes its ledger every 20 calls and at shutdown,
 *   so another project may hold unflushed calls. Every save stamps `builtAt`, so
 *   each project reports how fresh its contribution is and the caller can say so
 *   instead of quietly undercounting.
 *
 * Cost is not summed here. Ledger rows carry the pricing *inputs* and never a
 * cost field, which is what lets one price book price the whole fleet
 * consistently — including projects captured by an older Iris. Pricing stays
 * with the caller that owns the price book.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { irisHome } from "../config/projects.mjs";
import { costOf } from "./pricing.mjs";

/** Where a project's spend ledger lives, given its root. */
export function ledgerPathFor(cwd) {
  return join(cwd, ".claude", "history-index.json");
}

/**
 * Every project this machine has registered, whether or not it still exists.
 *
 * @returns {Array<{id:string,name:string,cwd:string,createdAt?:string}>}
 */
export function listProjects({ home = irisHome() } = {}) {
  const dir = join(home, "projects");
  let ids;
  try {
    ids = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    // FALLBACK-GUARD: INTENTIONAL — no registry yet is an empty fleet, not an error
    return [];
  }

  const out = [];
  for (const id of ids) {
    try {
      const meta = JSON.parse(readFileSync(join(dir, id, "project.json"), "utf8"));
      if (meta && typeof meta.cwd === "string") {
        out.push({
          id: String(meta.id || id),
          name: String(meta.name || id),
          cwd: meta.cwd,
          createdAt: meta.createdAt || null,
        });
      }
    } catch {
      // FALLBACK-GUARD: INTENTIONAL — one corrupt entry must not hide the rest
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Read one project's ledger.
 *
 * `state` distinguishes the three ways a project can contribute nothing, because
 * they mean different things to a total: it was deleted, its ledger could not be
 * read, or it genuinely has no calls yet.
 *
 * @returns {{state:'ok'|'gone'|'unreadable'|'empty', records:object[], builtAt:string|null}}
 */
export function readLedger(cwd) {
  if (!existsSync(cwd)) return { state: "gone", records: [], builtAt: null };
  const path = ledgerPathFor(cwd);
  if (!existsSync(path)) return { state: "empty", records: [], builtAt: null };
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    const records = Array.isArray(j?.records) ? j.records : Array.isArray(j) ? j : [];
    return {
      state: records.length ? "ok" : "empty",
      records,
      builtAt: j?.builtAt ?? null,
    };
  } catch {
    /* Distinct from "empty" on purpose: an unreadable ledger is a project whose
       spend is unknown, and a total that quietly treats it as zero is wrong. */
    return { state: "unreadable", records: [], builtAt: null };
  }
}

/**
 * Collect every project's rows, tagged with their origin.
 *
 * Rows are tagged rather than merged blindly: `id` is a per-session counter and
 * collides across projects, so only `uid` — which embeds a timestamp — is unique
 * fleet-wide. Callers that key on anything else will silently drop rows.
 *
 * @param {{ home?: string, currentId?: string }} [opts]
 * @returns {{
 *   projects: Array<{id,name,cwd,state,calls:number,builtAt:string|null,current:boolean}>,
 *   records: object[],
 *   totals: {projects:number, contributing:number, calls:number, unreadable:number, gone:number},
 * }}
 */
export function collectFleet({ home = irisHome(), currentId = null } = {}) {
  const projects = [];
  const records = [];
  let unreadable = 0;
  let gone = 0;

  for (const p of listProjects({ home })) {
    const { state, records: rows, builtAt } = readLedger(p.cwd);
    if (state === "unreadable") unreadable++;
    if (state === "gone") gone++;

    for (const r of rows) {
      /* Tag, never mutate the source object's identity fields — the caller
         prices these with the same code that prices live calls. */
      records.push({ ...r, projectId: p.id, projectName: p.name });
    }

    projects.push({
      ...p,
      state,
      calls: rows.length,
      builtAt,
      current: currentId != null && p.id === currentId,
    });
  }

  const contributing = projects.filter((p) => p.calls > 0).length;
  return {
    projects,
    records,
    totals: {
      projects: projects.length,
      contributing,
      calls: records.length,
      unreadable,
      gone,
    },
  };
}

/**
 * Reduce one project's rows to the figures a fleet view needs.
 *
 * Pricing happens here rather than in the browser so the response stays O(1) in
 * a project's call count instead of O(n): a machine with several long-lived
 * projects would otherwise ship tens of thousands of rows to render six table
 * rows. It uses the same price book the dashboard imports, so a fleet figure and
 * a per-project figure cannot disagree.
 *
 * A row whose model is not in the book contributes tokens but no cost, and is
 * counted in `unpriced` — the same rule the per-project view uses, so an unknown
 * model is visibly unpriced rather than quietly free.
 */
export function summarise(records) {
  let cost = 0, tok = 0, out = 0, unpriced = 0;
  const days = new Set();
  const models = Object.create(null);
  let first = null, last = null;

  for (const r of records) {
    const usage = {
      input: r.in ?? 0,
      cacheRead: r.cr ?? 0,
      cw5m: r.cw5 ?? 0,
      cw1h: r.cw1 ?? 0,
      cacheCreate: r.cw ?? 0,
      output: r.out ?? 0,
    };
    tok += usage.input + usage.cacheRead + usage.cacheCreate;
    out += usage.output;

    const c = costOf(usage, r.model, r.billing);
    if (c == null) unpriced++;
    else cost += c;

    if (r.model) models[r.model] = (models[r.model] || 0) + 1;
    const t = String(r.time || "");
    if (t) {
      days.add(t.slice(0, 10));
      if (!first || t < first) first = t;
      if (!last || t > last) last = t;
    }
  }

  return {
    calls: records.length,
    cost, tok, out, unpriced,
    activeDays: days.size,
    /* Kept so a fleet total can union days rather than add them — two projects
       touched on one day is one day of work, not two. Bounded by calendar days,
       so carrying it costs nothing. */
    days: [...days],
    models,
    first, last,
  };
}

/* Re-reading and re-parsing every ledger on each request is wasted work when
   nothing changed — and the largest ledger here is already 451 rows. Key the
   cache on each file's size and mtime: cheap to check, and it changes on every
   atomic rename, so a co-resident instance's write is never missed. */
const _cache = new Map();

function ledgerStamp(path) {
  try {
    const st = statSync(path);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return "none";
  }
}

/**
 * Per-project spend summaries across the machine, priced and cached.
 *
 * @param {{ home?: string, currentId?: string, withRecords?: boolean }} [opts]
 *   withRecords — include the raw rows. Off by default: the summaries are what a
 *   fleet view renders, and the rows are the part that does not scale.
 */
export function fleetSummary({ home = irisHome(), currentId = null, withRecords = false } = {}) {
  const projects = [];
  const all = [];
  let unreadable = 0, gone = 0;

  for (const p of listProjects({ home })) {
    const path = ledgerPathFor(p.cwd);
    const stamp = ledgerStamp(path);
    const key = `${p.id}:${path}`;
    let entry = _cache.get(key);

    if (!entry || entry.stamp !== stamp) {
      const { state, records, builtAt } = readLedger(p.cwd);
      entry = { stamp, state, builtAt, summary: summarise(records), records };
      _cache.set(key, entry);
    }

    if (entry.state === "unreadable") unreadable++;
    if (entry.state === "gone") gone++;

    projects.push({
      id: p.id, name: p.name, cwd: p.cwd,
      state: entry.state,
      builtAt: entry.builtAt,
      current: currentId != null && p.id === currentId,
      ...entry.summary,
    });

    if (withRecords) {
      for (const r of entry.records) all.push({ ...r, projectId: p.id, projectName: p.name });
    }
  }

  /* Summed from the per-project summaries rather than re-walking every row, so
     the aggregate costs nothing beyond what the projects already did. */
  const totals = {
    projects: projects.length,
    contributing: projects.filter((p) => p.calls > 0).length,
    calls: 0, cost: 0, tok: 0, out: 0, unpriced: 0,
    unreadable, gone,
  };
  const dayUnion = new Set();
  const models = Object.create(null);
  for (const p of projects) {
    totals.calls += p.calls;
    totals.cost += p.cost;
    totals.tok += p.tok;
    totals.out += p.out;
    totals.unpriced += p.unpriced;
    for (const d of p.days) dayUnion.add(d);
    for (const [m, n] of Object.entries(p.models)) models[m] = (models[m] || 0) + n;
  }
  /* Active days is a union, never a sum. */
  totals.activeDays = dayUnion.size;
  totals.models = models;

  return { projects, totals, records: withRecords ? all : undefined };
}
