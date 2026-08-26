// Anthropic list prices (USD per 1M tokens) — the single source for the whole tool.
//
// Nothing else holds a price. The server imports this module; the browser UI
// imports it too, served verbatim at /__pricing.mjs (routed in runtime/server.mjs,
// path in runtime/paths.mjs). It previously existed in three copies — here, inline
// in iris.html, and a substring-matched one in a second UI — and they drifted
// exactly as you would expect: a cancelled Sonnet 5 step-up lived on in two of
// them, and the second UI priced every Opus generation at retired Opus 4.1 rates.
// That second UI has since been deleted; this is the only price book left.
//
// `rateFor` takes a `billing` object rather than a model id alone because fast
// mode, batch and data residency all change the rate card, and a book that ignores
// them silently under-reports — fast mode by half.
//
//   in  base input        cr  cache hit / refresh (0.1x input)
//   cw5 5-minute write    (1.25x input)
//   cw1 1-hour write      (2x input)  ← Claude Code uses this TTL, and it is NOT
//   out output                          the same price as a 5m write
//
// Sorted longest-id-first so prefix matching picks the most specific model id: a new
// generation can never silently inherit the previous one's prices. An unknown id is
// reported as unpriced rather than guessed at.
export const PRICE_BOOK = [
  { id: "claude-fable-5",    label: "Fable 5",    in: 10,   cw5: 12.50, cw1: 20,   cr: 1,    out: 50 },
  { id: "claude-mythos-5",   label: "Mythos 5",   in: 10,   cw5: 12.50, cw1: 20,   cr: 1,    out: 50 },
  { id: "claude-opus-5",     label: "Opus 5",     in: 5,    cw5: 6.25,  cw1: 10,   cr: 0.50, out: 25 },
  { id: "claude-opus-4-8",   label: "Opus 4.8",   in: 5,    cw5: 6.25,  cw1: 10,   cr: 0.50, out: 25 },
  { id: "claude-opus-4-7",   label: "Opus 4.7",   in: 5,    cw5: 6.25,  cw1: 10,   cr: 0.50, out: 25 },
  { id: "claude-opus-4-6",   label: "Opus 4.6",   in: 5,    cw5: 6.25,  cw1: 10,   cr: 0.50, out: 25 },
  { id: "claude-opus-4-5",   label: "Opus 4.5",   in: 5,    cw5: 6.25,  cw1: 10,   cr: 0.50, out: 25 },
  { id: "claude-opus-4-1",   label: "Opus 4.1",   in: 15,   cw5: 18.75, cw1: 30,   cr: 1.50, out: 75 },
  { id: "claude-opus-4",     label: "Opus 4",     in: 15,   cw5: 18.75, cw1: 30,   cr: 1.50, out: 75 },
  /* Sonnet 5 launched at $2/$10 as introductory pricing through 2026-08-31. Anthropic
     has since cancelled the scheduled step-up to $3/$15 — "the previously scheduled
     increase ... on September 1, 2026 will not occur" — so $2/$10 is the standard
     price and this row carries no `until`/`after`. */
  { id: "claude-sonnet-5",   label: "Sonnet 5",   in: 2,    cw5: 2.50,  cw1: 4,    cr: 0.20, out: 10 },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6", in: 3,    cw5: 3.75,  cw1: 6,    cr: 0.30, out: 15 },
  { id: "claude-sonnet-4-5", label: "Sonnet 4.5", in: 3,    cw5: 3.75,  cw1: 6,    cr: 0.30, out: 15 },
  { id: "claude-sonnet-4",   label: "Sonnet 4",   in: 3,    cw5: 3.75,  cw1: 6,    cr: 0.30, out: 15 },
  { id: "claude-haiku-4-5",  label: "Haiku 4.5",  in: 1,    cw5: 1.25,  cw1: 2,    cr: 0.10, out: 5 },
  { id: "claude-haiku-3-5",  label: "Haiku 3.5",  in: 0.80, cw5: 1,     cw1: 1.60, cr: 0.08, out: 4 },
].sort((a, b) => b.id.length - a.id.length);

/* Fast mode (research preview) replaces the base rates on Opus 5 / 4.8; the cache
   multipliers then apply on top of the fast base, not the standard one. */
export const FAST_MODE = {
  "claude-opus-5": { in: 10, out: 50 },
  "claude-opus-4-8": { in: 10, out: 50 },
};
export const CACHE_MULT = { cw5: 1.25, cw1: 2, cr: 0.1 };

/* Long context: kept as a mechanism with nothing in it, deliberately. Every model in
   the book with a 1M window (Opus 5/4.8/4.7/4.6, Sonnet 5, Sonnet 4.6, Fable 5,
   Mythos 5) bills the full window at standard rates. The rest have a 200k window and
   cannot cross the threshold. If a premium tier is ever reintroduced, add
   `longCtx:{over:200000, in:…, cw5:…, cw1:…, cr:…, out:…}` to that model's row and
   the arithmetic below picks it up. An absent tier means the published price has none. */
export const LONG_CTX_THRESHOLD = 200000;

/* Server-side tools bill on top of tokens and are reported in usage.server_tool_use.
   Code execution bills by container-time (1,550 free hours/month), which a request
   count alone cannot price — so it is surfaced as unpriced, never guessed at. */
export const SERVER_TOOL_RATES = {
  web_search_requests: { usd: 0.01, label: "Web search", note: "$10 per 1,000 searches" },
  web_fetch_requests:  { usd: 0,    label: "Web fetch",  note: "no additional charge" },
};
export const SERVER_TOOL_UNPRICED = {
  code_execution_requests: { label: "Code execution", note: "billed by container-hour, not per request" },
};

/* The rate card carries each price under both namings on purpose. `input`/`output`/
   `cacheRead`/`cw5m`/`cw1h` is this module's API and what the tests and cache.mjs
   read; `in`/`out`/`cr`/`cw5`/`cw1` is the price-book naming the UIs render from.
   One object satisfying both is what lets the browser import this file directly
   instead of keeping its own copy — which is how the two drifted apart before. */
function toRates(row) {
  return {
    tier: row.tier ?? null,
    input: row.in,
    output: row.out,
    cacheRead: row.cr,
    cw5m: row.cw5,
    cw1h: row.cw1,
    in: row.in,
    out: row.out,
    cr: row.cr,
    cw5: row.cw5,
    cw1: row.cw1,
    note: row.note ?? null,
    longCtx: row.longCtx ?? false,
    unknownTier: row.unknownTier ?? null,
  };
}

/** Total input tokens on a usage object — the figure the long-context tier is keyed on. */
function inputTokensOf(usage) {
  if (!usage) return 0;
  const create = usage.cacheCreate ?? (usage.cw5m ?? 0) + (usage.cw1h ?? 0);
  return (usage.input ?? 0) + (usage.cacheRead ?? 0) + (create ?? 0);
}

/**
 * Longest-id-first prefix match against PRICE_BOOK, with the rate modifiers that
 * were actually applied to the call layered on top.
 *
 * @param {string|null|undefined} model
 * @param {{ speed?: string|null, batch?: boolean, inferenceGeo?: string|null, serviceTier?: string|null }|null} [billing]
 *   What the request asked for merged with what the response says was applied.
 * @param {number} [inputTokens]  selects the long-context tier where a model has one
 * @returns {{ tier: string|null, input: number, output: number, cacheRead: number,
 *             cw5m: number, cw1h: number, in: number, out: number, cr: number,
 *             cw5: number, cw1: number, note: string|null, longCtx: boolean,
 *             unknownTier: string|null }|null}  each price under both namings
 */
export function rateFor(model, billing, inputTokens) {
  if (!model) return null;
  // strip a beta/context suffix ("claude-opus-5[1m]") and any dated snapshot
  const id = String(model).toLowerCase().replace(/\[.*$/, "");
  const hit = PRICE_BOOK.find((r) => id.startsWith(r.id));
  if (!hit) return null;

  const row = { tier: hit.label, in: hit.in, cw5: hit.cw5, cw1: hit.cw1, cr: hit.cr, out: hit.out };
  const add = (n) => { row.note = row.note ? `${row.note} · ${n}` : n; };

  /* Dated price change: no row uses this today, kept so a future step-up is one
     `until`/`after` pair rather than a code change. */
  if (hit.until && Date.now() >= Date.parse(hit.until)) Object.assign(row, hit.after);

  const b = billing || {};

  /* long context: only applies where the published price defines a tier */
  const over = hit.longCtx?.over ?? LONG_CTX_THRESHOLD;
  if (hit.longCtx && inputTokens > over) {
    Object.assign(row, hit.longCtx);
    row.longCtx = true;
    add(`long context >${over}`);
  }

  const fast = b.speed === "fast" && FAST_MODE[hit.id];
  if (fast) {
    row.in = fast.in;
    row.out = fast.out;
    row.cw5 = row.in * CACHE_MULT.cw5;
    row.cw1 = row.in * CACHE_MULT.cw1;
    row.cr = row.in * CACHE_MULT.cr;
    add("fast mode");
  }
  if (b.batch) { for (const k of ["in", "cw5", "cw1", "cr", "out"]) row[k] *= 0.5; add("batch −50%"); }
  if (b.inferenceGeo === "us") { for (const k of ["in", "cw5", "cw1", "cr", "out"]) row[k] *= 1.1; add("us residency ×1.1"); }

  /* Anything other than the standard service tier may carry rates we don't hold.
     Surface it instead of quietly applying standard prices to a priority request. */
  if (b.serviceTier && b.serviceTier !== "standard" && b.serviceTier !== "not_available") {
    row.unknownTier = b.serviceTier;
    add(`service tier: ${b.serviceTier} (rates unverified)`);
  }

  return toRates(row);
}

/**
 * Token cost of one usage object at the model's list rates, with the call's own
 * rate modifiers applied. Server-tool fees bill on top and are not included here —
 * see `serverToolFees`.
 *
 * Returns null — not 0 — when the model is not in the book.
 *
 * @param {{ input?: number, cacheRead?: number, cacheCreate?: number, cw5m?: number, cw1h?: number, output?: number }|null|undefined} usage
 * @param {string|null|undefined} model
 * @param {{ speed?: string|null, batch?: boolean, inferenceGeo?: string|null, serviceTier?: string|null }|null} [billing]
 * @returns {number|null}
 */
export function costOf(usage, model, billing) {
  const r = rateFor(model, billing, inputTokensOf(usage));
  if (!r || !usage) return null;
  return (
    (usage.input ?? 0) * r.input +
    (usage.cacheRead ?? 0) * r.cacheRead +
    (usage.cw5m ?? 0) * r.cw5m +
    (usage.cw1h ?? 0) * r.cw1h +
    (usage.output ?? 0) * r.output
  ) / 1e6;
}

/**
 * Server-side tool fees for one call, from `usage.server_tool_use`. Tools with no
 * published per-request rate are listed under `unpriced` rather than costed at zero.
 *
 * @param {Record<string, number>|null|undefined} st
 * @returns {{ usd: number, lines: Array<{label: string, count: number, usd: number, note: string}>,
 *             unpriced: Array<{label: string, count: number, note: string}> }}
 */
export function serverToolFees(st) {
  const out = { usd: 0, lines: [], unpriced: [] };
  if (!st || typeof st !== "object") return out;
  for (const [key, n] of Object.entries(st)) {
    if (!n) continue;
    const r = SERVER_TOOL_RATES[key];
    if (r) {
      const usd = n * r.usd;
      out.usd += usd;
      out.lines.push({ label: r.label, count: n, usd, note: r.note });
      continue;
    }
    const u = SERVER_TOOL_UNPRICED[key];
    out.unpriced.push({ label: u ? u.label : key, count: n, note: u ? u.note : "no published per-request rate" });
  }
  return out;
}
